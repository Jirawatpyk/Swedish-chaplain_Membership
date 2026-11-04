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
 * key (both retried next run). A dry run applies the same rule on a plain
 * read and never locks a row. A failed delete is logged and metered and the
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
import { errKind } from '@/lib/log-id';
import { invoicingMetrics } from '@/lib/metrics';
import { deleteOrphanPdfUnderLock } from '../lib/delete-orphan-pdf';
import type { ClockPort } from '../ports/clock-port';
import type { InvoiceRepo } from '../ports/invoice-repo';
import { BlobChangedSinceUploadError, BlobKeyNotFoundError } from '../ports/blob-storage-port';
import type { OrphanPdfBlobItem, OrphanPdfBlobPort } from '../ports/orphan-pdf-blob-port';
import type { OrphanPdfReferenceRepo } from '../ports/orphan-pdf-reference-repo';
import type { Invoice, InvoiceId } from '../../domain/invoice';

/** A key younger than this is never looked up (in-flight upload). */
export const ORPHAN_PDF_MIN_AGE_MS = 60 * 60 * 1000;
/** The longest one listing page may take before that tenant is skipped. */
export const ORPHAN_PDF_LIST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 1000;
/**
 * #72 — Vercel keeps a bounded number of log lines per request (the first
 * prod run stopped at 256 and lost its summary). Per-key lines are a sample:
 * this many lines per info event (would_delete / deleted / already_gone) and
 * a reservoir of this many failures per run; the rest are only counted in the
 * summary. The route adds a request-wide budget across both cron halves.
 */
export const ORPHAN_PDF_LOG_SAMPLE = 20;
/** The breakdown keeps this many groups; the rest are counted. */
const BREAKDOWN_MAX_GROUPS = 50;
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
    readonly invoiceRepo: Pick<InvoiceRepo, 'withTx' | 'findByIdInTxForUpdate' | 'findByIdInTx'>;
  };
  readonly logger?: {
    info(meta: Record<string, unknown>, msg: string): void;
    warn(meta: Record<string, unknown>, msg: string): void;
    error(meta: Record<string, unknown>, msg: string): void;
  };
}

/** Outcomes of one `docKind × fy × templateVersion` group of candidate keys. */
export interface OrphanPdfBreakdownRow {
  readonly docKind: OrphanPdfKind;
  readonly fy: string;
  readonly templateVersion: number;
  readonly wouldDelete: number;
  readonly deleted: number;
  readonly kept: number;
  readonly alreadyGone: number;
  readonly failed: number;
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
      /** Unreferenced keys already gone when the delete arrived. */
      readonly alreadyGone: number;
      /** Tenants skipped because a listing page (or their repos) failed. */
      readonly listFailed: number;
      readonly truncated: boolean;
      /** Every candidate outcome by docKind × fy × templateVersion (sorted). */
      readonly breakdown: readonly OrphanPdfBreakdownRow[];
      /** The groups past the first 50 of the breakdown, with their totals. */
      readonly otherGroups: {
        readonly groups: number;
        readonly wouldDelete: number;
        readonly deleted: number;
        readonly kept: number;
        readonly alreadyGone: number;
        readonly failed: number;
      };
      /** Per-key log lines left out of the sample (#72). */
      readonly suppressedLines: { readonly info: number; readonly error: number };
    }
  | { readonly kind: 'scan_failed' };

type Outcome = 'deleted' | 'would_delete' | 'kept' | 'gone' | 'failed';
/** The per-key logger: a bounded sample of the run's logger (#72). */
interface SampledLog {
  info(meta: Record<string, unknown>, msg: string): void;
  error(meta: Record<string, unknown>, msg: string): void;
}
type Candidate = { readonly item: OrphanPdfBlobItem; readonly parsed: ParsedOrphanPdfKey };

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
    log?.error({ event: 'orphan_pdf_sweep_scan_failed', err: errKind(e) }, 'orphan PDF sweep: tenant list failed');
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
    alreadyGone: 0,
    listFailed: 0,
    tenantsCompleted: 0,
  };
  let truncated = false;
  const outOfBudget = () => Date.now() >= deadline || c.deleted + c.wouldDelete >= maxDeletes;
  interface GroupCounts {
    docKind: OrphanPdfKind;
    fy: string;
    templateVersion: number;
    wouldDelete: number;
    deleted: number;
    kept: number;
    alreadyGone: number;
    failed: number;
  }
  const groups = new Map<string, GroupCounts>();
  /** One place updates the counters and the breakdown, so they always agree. */
  const record = (p: ParsedOrphanPdfKey, o: Outcome) => {
    const id = `${p.kind}|${p.fy}|${p.templateVersion}`;
    let g = groups.get(id);
    if (g === undefined) {
      g = {
        docKind: p.kind,
        fy: p.fy,
        templateVersion: p.templateVersion,
        wouldDelete: 0,
        deleted: 0,
        kept: 0,
        alreadyGone: 0,
        failed: 0,
      };
      groups.set(id, g);
    }
    const field =
      o === 'deleted'
        ? 'deleted'
        : o === 'would_delete'
          ? 'wouldDelete'
          : o === 'kept'
            ? 'kept'
            : o === 'gone'
              ? 'alreadyGone'
              : 'failed';
    c[field] += 1;
    g[field] += 1;
  };
  // #72 — per-key lines are a sample. Each info event has its own budget, so
  // one event cannot crowd out another; failures are a reservoir over the
  // whole run (written just before the summary), so every night shows a
  // different slice and a key that fails every night is eventually named.
  const suppressed = { info: 0, error: 0 };
  const infoBudget = new Map<string, number>();
  const failureSample: Array<{ meta: Record<string, unknown>; msg: string }> = [];
  let failuresSeen = 0;
  const failedTenants = new Set<string>();
  const sampled: SampledLog = {
    info(meta, msg) {
      const event = String(meta.event);
      const left = infoBudget.get(event) ?? ORPHAN_PDF_LOG_SAMPLE;
      if (left > 0) {
        infoBudget.set(event, left - 1);
        log?.info(meta, msg);
      } else suppressed.info += 1;
    },
    error(meta, msg) {
      failuresSeen += 1;
      if (typeof meta.tenantId === 'string') failedTenants.add(meta.tenantId);
      if (failureSample.length < ORPHAN_PDF_LOG_SAMPLE) failureSample.push({ meta, msg });
      else {
        const j = Math.floor(Math.random() * failuresSeen);
        if (j < ORPHAN_PDF_LOG_SAMPLE) failureSample[j] = { meta, msg };
      }
    },
  };
  const tenantSkipped = (tenantId: string, step: 'repos' | 'list', e: unknown) => {
    c.listFailed += 1;
    invoicingMetrics.orphanBlobCleanupFailed('sweeper');
    log?.warn(
      { event: 'orphan_pdf_sweep_list_failed', tenantId, step, err: errKind(e) },
      'orphan PDF sweep: listing failed; tenant skipped until the next run',
    );
  };

  tenants: for (const tenantId of tenantIds) {
    let repos: ReturnType<SweepOrphanPdfsDeps['reposFor']>;
    try {
      repos = deps.reposFor(tenantId);
    } catch (e) {
      tenantSkipped(tenantId, 'repos', e);
      continue tenants;
    }
    const prefix = `invoicing/${tenantId}/`;
    let cursor: string | undefined;
    do {
      if (outOfBudget()) {
        truncated = true;
        break tenants;
      }
      let page;
      const remaining = deadline - Date.now();
      const signal = AbortSignal.timeout(Math.max(1, Math.min(ORPHAN_PDF_LIST_TIMEOUT_MS, remaining)));
      try {
        page = await deps.blob.listPage(prefix, cursor, PAGE_SIZE, { signal });
      } catch (e) {
        // Aborted by the run's own budget, not by a slow Blob: out of time.
        if (signal.aborted && remaining < ORPHAN_PDF_LIST_TIMEOUT_MS) {
          truncated = true;
          break tenants;
        }
        tenantSkipped(tenantId, 'list', e);
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
          for (const x of candidates) record(x.parsed, 'failed');
          invoicingMetrics.orphanBlobCleanupFailed('sweeper');
          log?.error(
            { event: 'orphan_pdf_sweep_lookup_failed', tenantId, keys: candidates.length, err: errKind(e) },
            'orphan PDF sweep: reference lookup failed; page kept until the next run',
          );
        }
      }

      if (referenced !== null) {
        for (const { item, parsed } of candidates) {
          if (referenced.has(item.key)) {
            record(parsed, 'kept');
            continue;
          }
          if (outOfBudget()) {
            truncated = true;
            break tenants;
          }
          record(parsed, await sweepOne(item, parsed, tenantId, repos, deps, dryRun, sampled, nowMs));
        }
      }
      if (page.hasMore && page.cursor === undefined) {
        // The rest of the folder cannot be reached: never report it checked.
        truncated = true;
        log?.warn(
          { event: 'orphan_pdf_sweep_cursor_missing', tenantId },
          'orphan PDF sweep: a page said there was more but gave no cursor; tenant left unfinished',
        );
        continue tenants;
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
  // Groups with something to act on first, then kept-only ones; each part in
  // key order. Groups past the cap keep their totals in `otherGroups`.
  const actionable = (g: GroupCounts) => g.wouldDelete + g.deleted + g.alreadyGone + g.failed > 0;
  const sorted = [...groups.values()].sort(
    (a, b) =>
      Number(actionable(b)) - Number(actionable(a)) ||
      a.docKind.localeCompare(b.docKind) ||
      a.fy.localeCompare(b.fy) ||
      a.templateVersion - b.templateVersion,
  );
  const breakdown: readonly OrphanPdfBreakdownRow[] = sorted.slice(0, BREAKDOWN_MAX_GROUPS);
  const rest = sorted.slice(BREAKDOWN_MAX_GROUPS);
  const sumOf = (f: 'wouldDelete' | 'deleted' | 'kept' | 'alreadyGone' | 'failed') =>
    rest.reduce((n, g) => n + g[f], 0);
  const otherGroups = {
    groups: rest.length,
    wouldDelete: sumOf('wouldDelete'),
    deleted: sumOf('deleted'),
    kept: sumOf('kept'),
    alreadyGone: sumOf('alreadyGone'),
    failed: sumOf('failed'),
  };
  for (const f of failureSample) log?.error(f.meta, f.msg);
  suppressed.error = failuresSeen - failureSample.length;
  const result = {
    kind: 'ok' as const,
    dryRun,
    tenants: tenantIds.length,
    tenantsCompleted,
    ...counts,
    truncated,
    breakdown,
    otherGroups,
    suppressedLines: suppressed,
  };
  if (truncated) {
    log?.warn(
      { event: 'orphan_pdf_sweep_truncated', tenants: tenantIds.length, tenantsCompleted, deleted: c.deleted },
      'orphan PDF sweep: stopped at its deadline or deletion cap; the next run continues',
    );
  }
  log?.info(
    { event: 'orphan_pdf_sweep_done', ...result, failedTenants: [...failedTenants].slice(0, 20), ms: Date.now() - startedAt },
    'orphan PDF sweep finished',
  );
  return result;
}

async function sweepOne(
  item: OrphanPdfBlobItem,
  parsed: ParsedOrphanPdfKey,
  tenantId: string,
  repos: ReturnType<SweepOrphanPdfsDeps['reposFor']>,
  deps: SweepOrphanPdfsDeps,
  dryRun: boolean,
  log: SampledLog,
  nowMs: number,
): Promise<Outcome> {
  // The document, never its key: the store is public by URL (PG-1).
  const meta = {
    tenantId,
    docKind: parsed.kind,
    documentId: parsed.id,
    fy: parsed.fy,
    templateVersion: parsed.templateVersion,
    ageMinutes: Math.round((nowMs - item.uploadedAt.getTime()) / 60_000),
  };
  const wouldDelete = (): Outcome => {
    log.info({ event: 'orphan_pdf_sweep_would_delete', ...meta }, 'orphan PDF sweep: would delete');
    return 'would_delete';
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
    } else if (dryRun) {
      // The same keep rule on a plain read: a report never locks a live row.
      const { invoiceRepo } = repos;
      const row = await invoiceRepo.withTx((tx) => invoiceRepo.findByIdInTx(tx, parsed.id as InvoiceId, tenantId));
      return row !== null && rowOwnsKey(row, item.key, parsed.kind) ? 'kept' : wouldDelete();
    } else {
      const outcome = await deleteOrphanPdfUnderLock(
        { invoiceRepo: repos.invoiceRepo, blob: deps.blob },
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
    log.info({ event: 'orphan_pdf_sweep_deleted', ...meta }, 'orphan PDF sweep: deleted an unreferenced PDF');
    return 'deleted';
  } catch (e) {
    if (e instanceof BlobKeyNotFoundError) {
      // Already gone (an overlapping run): the goal holds; nothing was deleted now.
      log.info({ event: 'orphan_pdf_sweep_already_gone', ...meta }, 'orphan PDF sweep: key already gone');
      return 'gone';
    }
    log.error(
      { event: 'orphan_pdf_sweep_failed', ...meta, err: errKind(e) },
      'orphan PDF sweep: could not check or delete a PDF; kept until the next run',
    );
    invoicingMetrics.orphanBlobCleanupFailed('sweeper');
    return 'failed';
  }
}
