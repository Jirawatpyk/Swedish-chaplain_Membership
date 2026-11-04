/**
 * #729 (task 63) — `sweepOrphanPdfs`: the daily reclaim of invoice, receipt
 * and credit-note PDFs that no row references.
 *
 * Issue, issue-as-paid, record payment and the credit-note issue upload their
 * PDF to a deterministic key inside the transaction:
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
 *   - invoice and receipt keys: re-read the invoice under `FOR UPDATE` (the
 *     lock every issue and payment holds while it uploads) and keep when its
 *     `pdf` or `receiptPdf` key is this key; otherwise delete while holding
 *     the lock, conditional on the listed etag (`deleteOrphanPdfUnderLock`);
 *   - credit-note keys: a `credit_notes` row commits together with its key,
 *     so keep when that row's key is this key; otherwise delete on the etag.
 * Only keys at least {@link ORPHAN_PDF_MIN_AGE_MS} old are looked at, far past
 * any in-flight transaction (300 s) or the async receipt worker's window.
 * Anything under the prefix that is not one of the three shapes (logos,
 * zero-rate certs, unknown files) is never touched.
 *
 * ── Fail-safe ────────────────────────────────────────────────────────────
 * A failed locked read or lookup keeps the key (retried next run). A failed
 * delete is logged and metered and the run goes on. A per-tenant listing
 * failure skips that tenant; only the tenant list failing is `scan_failed`.
 * No audit event: the bytes never became a committed tax document (the
 * committed ones are exactly the referenced keys, which are kept).
 *
 * Pure Application logic (Principle III).
 */
import { invoicingMetrics } from '@/lib/metrics';
import { deleteOrphanPdfUnderLock } from '../lib/delete-orphan-pdf';
import type { ClockPort } from '../ports/clock-port';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { InvoiceRepo } from '../ports/invoice-repo';
import { BlobChangedSinceUploadError } from '../ports/blob-storage-port';
import type { OrphanPdfBlobItem, OrphanPdfBlobPort } from '../ports/orphan-pdf-blob-port';
import type { CreditNoteId } from '../../domain/credit-note';
import type { InvoiceId } from '../../domain/invoice';

/** A key younger than this is never looked up (in-flight upload). */
export const ORPHAN_PDF_MIN_AGE_MS = 60 * 60 * 1000;
const PAGE_SIZE = 1000;
const DEFAULT_MAX_DELETES = 500;
const DEFAULT_DEADLINE_MS = 240_000;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export type OrphanPdfKind = 'invoice' | 'receipt' | 'credit_note';

/**
 * The document a key names, or null for anything that is not one of the
 * three PDF shapes in this tenant's folder (never deleted).
 */
export function parseOrphanPdfKey(
  key: string,
  tenantId: string,
): { readonly kind: OrphanPdfKind; readonly id: string } | null {
  const m = new RegExp(
    `^invoicing/${escapeRe(tenantId)}/\\d{4}/(credit-note_)?(${UUID})(_receipt)?_v\\d+\\.pdf$`,
  ).exec(key);
  if (m === null) return null;
  const [, creditNote, id, receipt] = m;
  if (creditNote !== undefined && receipt !== undefined) return null;
  return { kind: creditNote ? 'credit_note' : receipt ? 'receipt' : 'invoice', id: id! };
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
  /** The tenant's repos; each opens its own RLS-scoped transaction. */
  readonly reposFor: (tenantId: string) => {
    readonly invoiceRepo: Pick<InvoiceRepo, 'withTx' | 'findByIdInTxForUpdate'>;
    readonly creditNoteRepo: Pick<CreditNoteRepo, 'findById'>;
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
      readonly scanned: number;
      readonly deleted: number;
      /** Dry run only: keys the sweep would have deleted. */
      readonly wouldDelete: number;
      readonly kept: number;
      readonly skippedYoung: number;
      readonly skippedUnknown: number;
      readonly failed: number;
      readonly truncated: boolean;
    }
  | { readonly kind: 'scan_failed' };

type Outcome = 'deleted' | 'would_delete' | 'kept' | 'failed';

const errKind = (e: unknown) => (e instanceof Error ? e.constructor.name : 'unknown');

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

  const c = { scanned: 0, deleted: 0, wouldDelete: 0, kept: 0, skippedYoung: 0, skippedUnknown: 0, failed: 0 };
  let truncated = false;
  const outOfBudget = () => Date.now() >= deadline || c.deleted + c.wouldDelete >= maxDeletes;

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
        page = await deps.blob.listPage(prefix, cursor, PAGE_SIZE);
      } catch (e) {
        log?.warn(
          { event: 'orphan_pdf_sweep_list_failed', tenantId, errKind: errKind(e) },
          'orphan PDF sweep: listing failed; tenant skipped until the next run',
        );
        continue tenants;
      }
      for (const item of page.items) {
        if (outOfBudget()) {
          truncated = true;
          break tenants;
        }
        c.scanned += 1;
        const parsed = parseOrphanPdfKey(item.key, tenantId);
        if (parsed === null) {
          c.skippedUnknown += 1;
          continue;
        }
        if (nowMs - item.uploadedAt.getTime() < ORPHAN_PDF_MIN_AGE_MS) {
          c.skippedYoung += 1;
          continue;
        }
        const outcome = await sweepOne(item, parsed, tenantId, repos, deps, dryRun);
        if (outcome === 'deleted') c.deleted += 1;
        else if (outcome === 'would_delete') c.wouldDelete += 1;
        else if (outcome === 'kept') c.kept += 1;
        else c.failed += 1;
      }
      cursor = page.hasMore ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  const result = { kind: 'ok' as const, dryRun, tenants: tenantIds.length, ...c, truncated };
  log?.info({ event: 'orphan_pdf_sweep_done', ...result, ms: Date.now() - startedAt }, 'orphan PDF sweep finished');
  return result;
}

async function sweepOne(
  item: OrphanPdfBlobItem,
  parsed: { readonly kind: OrphanPdfKind; readonly id: string },
  tenantId: string,
  repos: ReturnType<SweepOrphanPdfsDeps['reposFor']>,
  deps: SweepOrphanPdfsDeps,
  dryRun: boolean,
): Promise<Outcome> {
  const log = deps.logger;
  const meta = {
    tenantId,
    key: item.key,
    docKind: parsed.kind,
    documentId: parsed.id,
    ageMinutes: Math.round((new Date(deps.clock.nowIso()).getTime() - item.uploadedAt.getTime()) / 60_000),
  };
  // The delete a dry run replaces: report it, change nothing.
  const dryBlob = {
    delete: async () => {
      throw new DryRunStop();
    },
  };
  try {
    if (parsed.kind === 'credit_note') {
      const note = await repos.creditNoteRepo.findById(parsed.id as CreditNoteId, tenantId);
      if (note !== null && note.pdf.blobKey === item.key) return 'kept';
      if (dryRun) {
        log?.info({ event: 'orphan_pdf_sweep_would_delete', ...meta }, 'orphan PDF sweep: would delete');
        return 'would_delete';
      }
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
          rowOwnsKey: (row) => row.pdf?.blobKey === item.key || row.receiptPdf?.blobKey === item.key,
        },
      );
      if (outcome !== 'deleted') return 'kept';
    }
    log?.info({ event: 'orphan_pdf_sweep_deleted', ...meta }, 'orphan PDF sweep: deleted an unreferenced PDF');
    return 'deleted';
  } catch (e) {
    if (e instanceof DryRunStop) {
      log?.info({ event: 'orphan_pdf_sweep_would_delete', ...meta }, 'orphan PDF sweep: would delete');
      return 'would_delete';
    }
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
