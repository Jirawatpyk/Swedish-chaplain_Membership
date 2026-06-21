/**
 * COMP-1 US3-B — shared buyer-PII redaction step, extracted verbatim from the
 * event-buyer cron so the member-invoice cron + the event-buyer cron share ONE
 * reviewed implementation. Parameterized by `documentTable` ('invoices' |
 * 'credit_notes'); the arm-specific eligible-QUERY stays in each route.
 *
 * The redaction tombstones the 5 buyer-PII fields on `member_identity_snapshot`
 * (legal_name/address/primary_contact_name → '[REDACTED]', primary_contact_email
 * → '', tax_id → NULL) — preserving the jsonb shape so the read-boundary zod +
 * the §86/4 PDF re-render stay valid — and purges the issued PDF blob BYTES,
 * with the HIGH-3 retryable `pii_blob_purged_at` marker. Runs ONLY under the
 * caller's `SET LOCAL app.allow_pii_redaction='true'` GUC (set in the route tx).
 */
import { sql } from 'drizzle-orm';
import type { TenantContext } from '@/modules/tenants';
import { runInTenant, type TenantTx } from '@/lib/db';
import type { AuditPort } from '@/modules/invoicing/application/ports/audit-port';

export type RedactionDocumentTable = 'invoices' | 'credit_notes';

/**
 * COMP-1 PR-review FIX #6 — default per-tick cap on each §87/3 redaction cron's
 * eligibility SELECT. Mirrors the value of the reconcile/dispatch crons' plain
 * `MAX_PER_TICK = 50` const; with `FOR UPDATE … SKIP LOCKED` each tick drains at
 * most this many un-contended rows, and the cron's periodic re-ticks drain the
 * rest — bounding one tick so a large >10y backlog cannot exceed `maxDuration`,
 * get the tx killed mid-loop, roll back, and starve forward progress.
 */
export const REDACTION_MAX_PER_TICK_DEFAULT = 50;

/**
 * The per-tick eligibility cap for a redaction cron, read LIVE from
 * `process.env.REDACTION_MAX_PER_TICK` at request time (the same live-read idiom
 * the outbox crons use for `CRON_SECRET`) so an operator — or an integration
 * test — can shrink it without rebuilding the cached `env` object. A missing /
 * non-numeric / non-positive value falls back to {@link REDACTION_MAX_PER_TICK_DEFAULT}.
 * Both §87/3 crons (member-invoice + event-buyer) share this single source so the
 * two arms stay byte-identical.
 */
export function redactionMaxPerTick(): number {
  const raw = process.env.REDACTION_MAX_PER_TICK;
  if (raw === undefined) return REDACTION_MAX_PER_TICK_DEFAULT;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : REDACTION_MAX_PER_TICK_DEFAULT;
}

/** PII fields tombstoned on the buyer snapshot. NAMES only — never values. */
export const REDACTED_BUYER_FIELDS = [
  'legal_name',
  'address',
  'primary_contact_name',
  'primary_contact_email',
  'tax_id',
] as const;

export interface RedactionPurgeWorkItem {
  readonly documentTable: RedactionDocumentTable;
  readonly documentId: string;
  readonly keys: readonly string[];
  /** true → tombstoned on THIS pass; false → a retry purging an already-tombstoned row. */
  readonly tombstonedThisRun: boolean;
}

/**
 * Outcome of a per-row redaction attempt. `kind` drives the caller's `redacted`
 * count — a `'tombstoned'` row counts even when it has ZERO blob keys, which is
 * what closes the old `null`-return undercount (a fresh zero-blob redaction used
 * to be indistinguishable from a lost race and so went uncounted). `purge` (when
 * present) is the post-commit blob-purge work item; null when there is nothing
 * to purge.
 */
export type RedactionStepOutcome =
  | { readonly kind: 'tombstoned'; readonly purge: RedactionPurgeWorkItem | null }
  | { readonly kind: 'retry'; readonly purge: RedactionPurgeWorkItem }
  | { readonly kind: 'lost_race' };

/**
 * The document discriminator merged into the audit payload. A closed union so a
 * call site cannot forget or typo the discriminator (`document_kind` + its
 * companion key). Three shapes:
 *   - NON-member (event-buyer) arm — `document_kind` ONLY, NO `member_id`. A
 *     non-member event row has no member, so it must NEVER carry `member_id`
 *     (that would falsely surface the redaction in the per-member F3 timeline /
 *     erasure-evidence arm, which keys on `payload.member_id`). The literal
 *     `document_kind` carries no PII — it just makes the audit row self-describing
 *     (invoice-vs-credit_note) instead of relying on the id-column key.
 *   - MEMBER invoice arm — `member_id` + `document_kind:'invoice'` + `invoice_subject`.
 *   - MEMBER credit-note arm — `member_id` + `document_kind:'credit_note'` + `original_invoice_id`.
 */
export type RedactionAuditExtra =
  | { readonly document_kind: 'invoice' | 'credit_note' }
  | { readonly member_id: string; readonly document_kind: 'invoice'; readonly invoice_subject: 'membership' | 'event' }
  | { readonly member_id: string; readonly document_kind: 'credit_note'; readonly original_invoice_id: string };

/**
 * In-tx: tombstone the buyer snapshot (RETURNING-gated for audit-once), stamp
 * the marker for a zero-blob row, and emit `event_buyer_pii_redacted`. Returns a
 * tagged `RedactionStepOutcome`: `'tombstoned'` (this pass redacted the row —
 * ALWAYS counted, even with zero blob keys), `'retry'` (an already-tombstoned
 * row whose blob purge is outstanding — queue the purge, do NOT re-audit), or
 * `'lost_race'` (a concurrent instance owns the row — do nothing).
 *
 * `alreadyTombstoned` (the SELECT's `legal_name = '[REDACTED]'` flag) → the
 * retry case: skip the tombstone UPDATE + audit, only queue the blob purge.
 */
export async function tombstoneBuyerPiiAndAuditInTx(params: {
  readonly tx: TenantTx;
  readonly documentTable: RedactionDocumentTable;
  readonly documentId: string;
  readonly blobKeys: readonly string[];
  readonly alreadyTombstoned: boolean;
  readonly audit: AuditPort;
  readonly auditPayloadExtra: RedactionAuditExtra;
  readonly tenantId: string;
  readonly requestId: string | null;
  readonly route: string;
}): Promise<RedactionStepOutcome> {
  const { tx, documentTable, documentId, blobKeys, alreadyTombstoned } = params;

  if (alreadyTombstoned) {
    return blobKeys.length > 0
      ? { kind: 'retry', purge: { documentTable, documentId, keys: blobKeys, tombstonedThisRun: false } }
      : { kind: 'lost_race' }; // already redacted, nothing to purge (retry SELECT-arm requires a key → unreachable).
  }

  const redactedAt = new Date().toISOString();

  // Tombstone the 5 PII fields, preserving the jsonb shape (read-boundary zod +
  // §86/4 re-render stay valid). RETURNING-gated: a concurrent instance that
  // already tombstoned the row makes this match 0 rows → no double-audit. The id
  // column + table are hardcoded per `documentTable` (no sql.raw → injection-safe).
  const tombstoned =
    documentTable === 'invoices'
      ? ((await tx.execute(sql`
          UPDATE invoices
          SET member_identity_snapshot = member_identity_snapshot
            || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
                 'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL)
          WHERE invoice_id = ${documentId}
            AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
          RETURNING invoice_id
        `)) as unknown as Array<{ invoice_id: string }>)
      : ((await tx.execute(sql`
          UPDATE credit_notes
          SET member_identity_snapshot = member_identity_snapshot
            || jsonb_build_object('legal_name','[REDACTED]','address','[REDACTED]',
                 'primary_contact_name','[REDACTED]','primary_contact_email','','tax_id',NULL)
          WHERE credit_note_id = ${documentId}
            AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
          RETURNING credit_note_id
        `)) as unknown as Array<{ credit_note_id: string }>);

  if (tombstoned.length !== 1) return { kind: 'lost_race' }; // concurrent instance owns this row.

  // Zero-blob row: redaction complete the instant the snapshot is tombstoned —
  // stamp the marker in THIS GUC tx (defence-in-depth; non-draft invoices always
  // carry a PDF key, but a future doc-kind / data fix might not). The
  // `tenant_id` predicate mirrors the post-commit marker UPDATE (both already
  // run under RLS — belt-and-suspenders, consistent).
  if (blobKeys.length === 0) {
    if (documentTable === 'invoices') {
      await tx.execute(sql`UPDATE invoices SET pii_blob_purged_at = now() WHERE invoice_id = ${documentId} AND tenant_id = ${params.tenantId} AND pii_blob_purged_at IS NULL`);
    } else {
      await tx.execute(sql`UPDATE credit_notes SET pii_blob_purged_at = now() WHERE credit_note_id = ${documentId} AND tenant_id = ${params.tenantId} AND pii_blob_purged_at IS NULL`);
    }
  }

  // Audit in the SAME tx (atomic). Emitted EXACTLY ONCE per row (RETURNING gate).
  // Field NAMES only — never the erased PII values. 10y retention via the adapter.
  // `idColumn` is the audit-payload key only (the UPDATEs above hardcode the column).
  const idColumn = documentTable === 'invoices' ? 'invoice_id' : 'credit_note_id';
  await params.audit.emit(tx, {
    eventType: 'event_buyer_pii_redacted',
    actorUserId: 'system:cron',
    summary: 'event_buyer_pii_redacted',
    payload: {
      ...params.auditPayloadExtra,
      [idColumn]: documentId,
      redacted_at: redactedAt,
      redacted_fields: [...REDACTED_BUYER_FIELDS],
      blob_purged_keys: blobKeys,
      reason: 'retention_10y_elapsed',
      route: params.route,
    },
    tenantId: params.tenantId,
    requestId: params.requestId,
  });

  return blobKeys.length > 0
    ? { kind: 'tombstoned', purge: { documentTable, documentId, keys: blobKeys, tombstonedThisRun: true } }
    : { kind: 'tombstoned', purge: null }; // fresh redaction, nothing to purge — STILL counted.
}

/**
 * Apply a per-row redaction outcome: queue its blob-purge work item (when there
 * is one) and return how much it adds to the tenant's `redacted` tally —
 * `'tombstoned'` → 1 (a fresh redaction, counted even when `purge` is null, the
 * zero-blob case that closes the old undercount), `'retry'` → 0 (queues the
 * purge of an already-tombstoned row WITHOUT re-counting it), `'lost_race'` → 0
 * (a concurrent instance owns the row — nothing to do). Centralises the
 * discriminated-union narrowing (`'lost_race'` carries no `purge`) so all three
 * cron call sites stay byte-identical and the contract lives beside the type.
 */
export function applyRedactionOutcome(
  outcome: RedactionStepOutcome,
  purgeWork: RedactionPurgeWorkItem[],
): number {
  if (outcome.kind !== 'lost_race' && outcome.purge !== null) {
    purgeWork.push(outcome.purge);
  }
  return outcome.kind === 'tombstoned' ? 1 : 0;
}

/**
 * Post-commit: purge the PDF blob BYTES best-effort; ONLY on a fully successful
 * purge of every key, stamp `pii_blob_purged_at` via a SEPARATE GUC tx. A crash
 * before the stamp leaves the marker NULL → the next sweep re-selects + retries
 * (snapshot already tombstoned → no PII re-exposed, audit not re-emitted).
 */
export async function purgeBuyerPdfBlobsAndStampMarker(params: {
  readonly ctx: TenantContext;
  readonly item: RedactionPurgeWorkItem;
  readonly tenantId: string;
  readonly blobDelete: (key: string) => Promise<void>;
  readonly onPurged: (kind: 'fresh' | 'retry') => void;
  /**
   * Called per error with the document id + the error CLASS NAME (never the
   * message — a PG/Blob error message can carry SQL fragments / keys; forbidden-
   * fields hygiene) + the `phase` so the caller can pick the right log message +
   * bump the error metric. `phase: 'blob_delete'` = a PDF-byte delete failed;
   * `phase: 'marker'` = the post-purge `pii_blob_purged_at` stamp failed.
   */
  readonly onError: (info: {
    readonly documentId: string;
    readonly errKind: string;
    readonly phase: 'blob_delete' | 'marker';
  }) => void;
}): Promise<void> {
  const { ctx, item, tenantId } = params;
  let allPurged = true;
  for (const key of item.keys) {
    try {
      await params.blobDelete(key);
    } catch (e) {
      allPurged = false;
      params.onError({
        documentId: item.documentId,
        errKind: e instanceof Error ? e.constructor.name : 'unknown',
        phase: 'blob_delete',
      });
    }
  }
  if (!allPurged) return; // marker stays NULL → retried next tick.

  try {
    await runInTenant(ctx, async (tx) => {
      await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);
      if (item.documentTable === 'invoices') {
        await tx.execute(sql`UPDATE invoices SET pii_blob_purged_at = now() WHERE invoice_id = ${item.documentId} AND tenant_id = ${tenantId} AND pii_blob_purged_at IS NULL`);
      } else {
        await tx.execute(sql`UPDATE credit_notes SET pii_blob_purged_at = now() WHERE credit_note_id = ${item.documentId} AND tenant_id = ${tenantId} AND pii_blob_purged_at IS NULL`);
      }
    });
    params.onPurged(item.tombstonedThisRun ? 'fresh' : 'retry');
  } catch (e) {
    params.onError({
      documentId: item.documentId,
      errKind: e instanceof Error ? e.constructor.name : 'unknown',
      phase: 'marker',
    });
  }
}
