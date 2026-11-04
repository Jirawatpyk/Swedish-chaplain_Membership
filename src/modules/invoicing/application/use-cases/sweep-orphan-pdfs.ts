/**
 * #729 (task 63) — `sweepOrphanPdfs`: the daily reclaim of invoice, receipt
 * and credit-note PDFs that no row references.
 *
 * Issue, issue-as-paid, record payment, the async receipt render and the
 * credit-note issue upload their PDF to a deterministic key:
 *   invoicing/{tenant}/{fy}/{invoiceId}_v{n}.pdf          invoice / bill
 *   invoicing/{tenant}/{fy}/{invoiceId}_receipt_v{n}.pdf  receipt
 *   invoicing/{tenant}/{fy}/credit-note_{id}_v{n}.pdf     credit note
 * (`n` is the template version.) The catch-path cleanup
 * (`lib/delete-orphan-pdf.ts`) covers a use case that fails by itself. Bytes
 * still outlive their transaction when the function is killed after the
 * upload, when a caller-owned transaction rolls back after the use case
 * returned ok, when the admin voids instead of retrying, or when a template
 * bump makes the retry write `_v{n+1}`. A leftover receipt can carry an RC
 * number the rollback freed. Credit notes have no catch-path cleanup at all.
 *
 * ── The keep rule ────────────────────────────────────────────────────────
 * A key is never matched by pattern. It is kept iff the row its name points
 * at references exactly that key:
 *   1. one lock-free batch read per page (`referencedKeys`) keeps every key
 *      a row references. A committed row's keys never change, so this needs
 *      no lock, and a page of kept keys costs one query, not one lock each;
 *   2. an invoice or receipt key it does not return is re-read under
 *      `FOR UPDATE` (the lock issue and payment hold while they upload) and
 *      deleted while holding it, conditional on the listed etag
 *      (`deleteOrphanPdfUnderLock`). A receipt key is also kept while the
 *      invoice is paid and its async receipt is still pending or failed: that
 *      worker uploads before it takes the lock, and its byte-identical
 *      re-render may keep the etag, so the etag alone cannot protect it;
 *   3. a credit-note key it does not return is deleted on the etag: a
 *      `credit_notes` row commits together with its key, under a fresh id per
 *      attempt.
 * Only keys at least {@link ORPHAN_PDF_MIN_AGE_MS} old are looked at, far past
 * any in-flight transaction (300 s). Anything under the prefix that is not
 * one of the three shapes (logos, zero-rate certs, unknown files) is never
 * touched.
 *
 * ── Fail-safe ────────────────────────────────────────────────────────────
 * A failed batch read keeps its whole page; a failed locked read keeps the
 * key (both retried next run). A failed delete is logged and metered and the
 * run goes on. Each listing page is bounded by
 * {@link ORPHAN_PDF_LIST_TIMEOUT_MS}; a failed listing skips that tenant, is
 * counted and metered, and every tenant failing is `scan_failed`, so a dead
 * Blob token cannot report green. Logs name the document (fy, kind, id,
 * template version), never the key: the store is public by URL (PG-1).
 * No audit event: the bytes never became a committed tax document (the
 * committed ones are exactly the referenced keys, which are kept).
 *
 * Pure Application logic (Principle III).
 */
import { invoicingMetrics } from '@/lib/metrics';
import { deleteOrphanPdfUnderLock } from '../lib/delete-orphan-pdf';
import type { ClockPort } from '../ports/clock-port';
import type { InvoiceRepo } from '../ports/invoice-repo';
import { BlobChangedSinceUploadError } from '../ports/blob-storage-port';
import type { OrphanPdfBlobItem, OrphanPdfBlobPort } from '../ports/orphan-pdf-blob-port';
import type { OrphanPdfReferenceRepo } from '../ports/orphan-pdf-reference-repo';
import type { Invoice, InvoiceId } from '../../domain/invoice';

/** A key younger than this is never looked up (in-flight upload). */
export const ORPHAN_PDF_MIN_AGE_MS = 60 * 60 * 1000;
/** The longest one listing page may take before that tenant is skipped. */
export const ORPHAN_PDF_LIST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 1000;
const DEFAULT_MAX_DELETES = 500;
const DEFAULT_DEADLINE_MS = 240_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type OrphanPdfKind = 'invoice' | 'receipt' | 'credit_note';

export interface ParsedOrphanPdfKey {
  readonly kind: OrphanPdfKind;
  readonly id: string;
  readonly fy: string;
  readonly templateVersion: number;
}

/**
 * The document a key names, or null for anything that is not one of the
 * three PDF shapes in this tenant's folder (never deleted).
 */
export function parseOrphanPdfKey(key: string, tenantId: string): ParsedOrphanPdfKey | null {
  const m = new RegExp(
    `^invoicing/${escapeRe(tenantId)}/(\\d{4})/(credit-note_)?(${UUID})(_receipt)?_v(\\d+)\\.pdf$`,
  ).exec(key);
  if (m === null) return null;
  const [, fy, creditNote, id, receipt, version] = m;
  if (creditNote !== undefined && receipt !== undefined) return null;
  return {
    kind: creditNote ? 'credit_note' : receipt ? 'receipt' : 'invoice',
    id: id!,
    fy: fy!,
    templateVersion: Number(version),
  };
}

export interface SweepOrphanPdfsInput {
  /** Report what would be deleted; delete nothing. */
  readonly dryRun?: boolean;
  readonly maxDeletes?: number;
  readonly deadlineMs?: number;
}

export interface SweepOrphanPdfsDeps {
  readonly blob: OrphanPdfBlobPort;
  readonly clock: ClockPort;
  /** Every tenant that can own invoicing PDFs (owner-role read). */
  readonly listTenantIds: () => Promise<readonly string[]>;
  /** The lock-free batch read, run in the tenant's RLS-scoped transaction. */
  readonly referencedKeys: OrphanPdfReferenceRepo['referencedKeys'];
  /** The tenant's invoice repo; it opens its own RLS-scoped transaction. */
  readonly reposFor: (tenantId: string) => {
    readonly invoiceRepo: Pick<InvoiceRepo, 'withTx' | 'findByIdInTxForUpdate'>;
  };
  readonly logger?: {
    info(meta: Record<string, unknown>, msg: string): void;
    warn(meta: Record<string, unknown>, msg: string): void;
    error(meta: Record<string, unknown>, msg: string): void;
  };
}

export type SweepOrphanPdfsOutput =
  | {
      readonly kind: 'ok';
      readonly dryRun: boolean;
      readonly tenants: number;
      /** Tenants whose whole folder was listed and checked. */
      readonly tenantsCompleted: number;
      readonly scanned: number;
      readonly deleted: number;
      /** Dry run only: keys the sweep would have deleted. */
      readonly wouldDelete: number;
      readonly kept: number;
      readonly skippedYoung: number;
      readonly skippedUnknown: number;
      readonly failed: number;
      /** Tenants skipped because a listing page failed. */
      readonly listFailed: number;
      readonly truncated: boolean;
    }
  | { readonly kind: 'scan_failed' };

type Outcome = 'deleted' | 'would_delete' | 'kept' | 'failed';
type Candidate = { readonly item: OrphanPdfBlobItem; readonly parsed: ParsedOrphanPdfKey };

const errKind = (e: unknown) => (e instanceof Error ? e.constructor.name : 'unknown');

/** Whether the locked row still owns `key` (rule 2 in the header). */
function rowOwnsKey(row: Invoice, key: string, kind: OrphanPdfKind): boolean {
  if (row.pdf?.blobKey === key || row.receiptPdf?.blobKey === key) return true;
  return (
    kind === 'receipt' &&
    row.status === 'paid' &&
    (row.receiptPdfStatus === 'pending' || row.receiptPdfStatus === 'failed')
  );
}

export async function sweepOrphanPdfs(
  input: SweepOrphanPdfsInput,
  deps: SweepOrphanPdfsDeps,
): Promise<SweepOrphanPdfsOutput> {
  const dryRun = input.dryRun === true;
  const maxDeletes = input.maxDeletes ?? DEFAULT_MAX_DELETES;
  const startedAt = Date.now();
  const deadline = startedAt + (input.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const nowMs = new Date(deps.clock.nowIso()).getTime();
  const log = deps.logger;

  let tenantIds: readonly string[];
  try {
    tenantIds = await deps.listTenantIds();
  } catch (e) {
    log?.error({ event: 'orphan_pdf_sweep_scan_failed', errKind: errKind(e) }, 'orphan PDF sweep: tenant list failed');
    return { kind: 'scan_failed' };
  }
  if (tenantIds.length === 0) {
    log?.warn({ event: 'orphan_pdf_sweep_no_tenants' }, 'orphan PDF sweep: no tenant has invoice settings');
  }

  const c = {
    scanned: 0,
    deleted: 0,
    wouldDelete: 0,
    kept: 0,
    skippedYoung: 0,
    skippedUnknown: 0,
    failed: 0,
    listFailed: 0,
    tenantsCompleted: 0,
  };
  let truncated = false;
  const outOfBudget = () => Date.now() >= deadline || c.deleted + c.wouldDelete >= maxDeletes;
  const count = (o: Outcome) => {
    if (o === 'deleted') c.deleted += 1;
    else if (o === 'would_delete') c.wouldDelete += 1;
    else if (o === 'kept') c.kept += 1;
    else c.failed += 1;
  };

  tenants: for (const tenantId of tenantIds) {
    const repos = deps.reposFor(tenantId);
    const prefix = `invoicing/${tenantId}/`;
    let cursor: string | undefined;
    do {
      if (outOfBudget()) {
        truncated = true;
        break tenants;
      }
      let page;
      try {
        const signal = AbortSignal.timeout(Math.max(1, Math.min(ORPHAN_PDF_LIST_TIMEOUT_MS, deadline - Date.now())));
        page = await deps.blob.listPage(prefix, cursor, PAGE_SIZE, { signal });
      } catch (e) {
        c.listFailed += 1;
        invoicingMetrics.orphanBlobCleanupFailed('sweeper');
        log?.warn(
          { event: 'orphan_pdf_sweep_list_failed', tenantId, errKind: errKind(e) },
          'orphan PDF sweep: listing failed; tenant skipped until the next run',
        );
        continue tenants;
      }

      const candidates: Candidate[] = [];
      for (const item of page.items) {
        c.scanned += 1;
        const parsed = parseOrphanPdfKey(item.key, tenantId);
        if (parsed === null) c.skippedUnknown += 1;
        else if (nowMs - item.uploadedAt.getTime() < ORPHAN_PDF_MIN_AGE_MS) c.skippedYoung += 1;
        else candidates.push({ item, parsed });
      }

      let referenced: ReadonlySet<string> | null = null;
      if (candidates.length > 0) {
        const idsOf = (pred: (k: OrphanPdfKind) => boolean) => [
          ...new Set(candidates.filter((x) => pred(x.parsed.kind)).map((x) => x.parsed.id)),
        ];
        try {
          referenced = await deps.referencedKeys(tenantId, {
            invoiceIds: idsOf((k) => k !== 'credit_note'),
            creditNoteIds: idsOf((k) => k === 'credit_note'),
          });
        } catch (e) {
          // Fail-safe: nothing on this page is deleted; next run retries it.
          c.failed += candidates.length;
          invoicingMetrics.orphanBlobCleanupFailed('sweeper');
          log?.error(
            { event: 'orphan_pdf_sweep_lookup_failed', tenantId, keys: candidates.length, errKind: errKind(e) },
            'orphan PDF sweep: reference lookup failed; page kept until the next run',
          );
        }
      }

      if (referenced !== null) {
        for (const { item, parsed } of candidates) {
          if (referenced.has(item.key)) {
            c.kept += 1;
            continue;
          }
          if (outOfBudget()) {
            truncated = true;
            break tenants;
          }
          count(await sweepOne(item, parsed, tenantId, repos, deps, dryRun));
        }
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
    c.tenantsCompleted += 1;
  }

  if (tenantIds.length > 0 && c.listFailed === tenantIds.length) {
    log?.error(
      { event: 'orphan_pdf_sweep_scan_failed', tenants: tenantIds.length },
      'orphan PDF sweep: every tenant listing failed',
    );
    return { kind: 'scan_failed' };
  }

  const { tenantsCompleted, ...counts } = c;
  const result = { kind: 'ok' as const, dryRun, tenants: tenantIds.length, tenantsCompleted, ...counts, truncated };
  if (truncated) {
    log?.warn(
      { event: 'orphan_pdf_sweep_truncated', tenants: tenantIds.length, tenantsCompleted, deleted: c.deleted },
      'orphan PDF sweep: stopped at its deadline or deletion cap; the next run continues',
    );
  }
  log?.info({ event: 'orphan_pdf_sweep_done', ...result, ms: Date.now() - startedAt }, 'orphan PDF sweep finished');
  return result;
}

async function sweepOne(
  item: OrphanPdfBlobItem,
  parsed: ParsedOrphanPdfKey,
  tenantId: string,
  repos: ReturnType<SweepOrphanPdfsDeps['reposFor']>,
  deps: SweepOrphanPdfsDeps,
  dryRun: boolean,
): Promise<Outcome> {
  const log = deps.logger;
  // The document, never its key: the store is public by URL (PG-1).
  const meta = {
    tenantId,
    docKind: parsed.kind,
    documentId: parsed.id,
    fy: parsed.fy,
    templateVersion: parsed.templateVersion,
    ageMinutes: Math.round((new Date(deps.clock.nowIso()).getTime() - item.uploadedAt.getTime()) / 60_000),
  };
  const wouldDelete = (): Outcome => {
    log?.info({ event: 'orphan_pdf_sweep_would_delete', ...meta }, 'orphan PDF sweep: would delete');
    return 'would_delete';
  };
  // The delete a dry run replaces: report it, change nothing.
  const dryBlob = {
    delete: async () => {
      throw new DryRunStop();
    },
  };
  try {
    if (parsed.kind === 'credit_note') {
      // The batch read found no credit_notes row with this key.
      if (dryRun) return wouldDelete();
      try {
        await deps.blob.delete(item.key, { ifMatch: item.etag });
      } catch (e) {
        if (e instanceof BlobChangedSinceUploadError) return 'kept';
        throw e;
      }
    } else {
      const outcome = await deleteOrphanPdfUnderLock(
        { invoiceRepo: repos.invoiceRepo, blob: dryRun ? dryBlob : deps.blob },
        {
          invoiceId: parsed.id as InvoiceId,
          tenantId,
          blobKey: item.key,
          etag: item.etag,
          rowOwnsKey: (row) => rowOwnsKey(row, item.key, parsed.kind),
        },
      );
      if (outcome !== 'deleted') return 'kept';
    }
    log?.info({ event: 'orphan_pdf_sweep_deleted', ...meta }, 'orphan PDF sweep: deleted an unreferenced PDF');
    return 'deleted';
  } catch (e) {
    if (e instanceof DryRunStop) return wouldDelete();
    log?.error(
      { event: 'orphan_pdf_sweep_failed', ...meta, errKind: errKind(e) },
      'orphan PDF sweep: could not check or delete a PDF; kept until the next run',
    );
    invoicingMetrics.orphanBlobCleanupFailed('sweeper');
    return 'failed';
  }
}

/** Thrown by the dry-run blob in place of a delete (never escapes). */
class DryRunStop extends Error {}
