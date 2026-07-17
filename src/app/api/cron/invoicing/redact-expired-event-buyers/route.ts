/**
 * POST `/api/cron/invoicing/redact-expired-event-buyers`
 *
 * 054-event-fee-invoices (Task 15) — 10-year PII-redaction sweep for
 * NON-MEMBER event-invoice buyers.
 *
 * Thai RD §87/3 + §86/10 require a §86/4 tax document be retained for 10
 * years. Once that window elapses, GDPR Art. 5(1)(e) (storage limitation)
 * + Art. 17 (erasure) require the personal data on it be minimised. For a
 * non-member event invoice the buyer PII lives in `member_identity_snapshot`
 * (member_id IS NULL). This sweep tombstones JUST that column — preserving
 * every financial / §87-numbering field, which the §87/3 statutory record
 * and any later RD audit still need — and emits `event_buyer_pii_redacted`.
 *
 * ── PDF blob purge (complete erasure, RETRYABLE) ───────────────────────────
 * The buyer PII is ALSO printed on the issued §86/4 tax-document PDF(s) (name
 * / address / tax_id), stored in Vercel Blob at a public, non-expiring URL.
 * Tombstoning only the DB snapshot would leave that PII readable on the blob
 * — INCOMPLETE erasure (GDPR Art. 17). So this cron also DELETES the invoice
 * PDF blob and (if present) the receipt PDF blob. The `pdf_blob_key` /
 * `receipt_pdf_blob_key` COLUMNS are intentionally left intact: they are the
 * document reference for the §87/3 statutory record; only the underlying BYTES
 * are erased. The invoice-detail Blob-miss recovery path already tolerates a
 * dangling key.
 *
 * RETRYABILITY (code-review HIGH-3): the old design tombstoned + committed,
 * THEN purged best-effort — a crash between commit and purge stranded PII PDF
 * bytes on Blob FOREVER, because the row was now tombstoned
 * (`legal_name='[REDACTED]'`) and the old predicate excluded it from the next
 * sweep. The fix is a nullable `pii_blob_purged_at` marker column:
 *   (a) in the tenant tx under the GUC: tombstone the snapshot via an UPDATE that
 *       `RETURNING`s the row, then emit the audit + queue the purge ONLY when the
 *       UPDATE actually changed a row (round-2 FIX 1 — audit-once is gated on the
 *       UPDATE's real effect, not the stale SELECT flag, so a concurrent instance
 *       that already tombstoned the row cannot trigger a duplicate audit); commit.
 *       For a tombstoned row with ZERO blob keys, stamp `pii_blob_purged_at` in
 *       this SAME tx (round-2 FIX 2 — the purge is trivially complete; nothing to
 *       erase) so the marker is never left permanently NULL.
 *   (b) purge the blob bytes best-effort (each delete try/catch'd, logged with
 *       errKind only + the error metric on failure) — only for rows WITH keys.
 *   (c) ONLY on a fully successful purge of ALL the row's blob keys, set
 *       `pii_blob_purged_at = now()` via a SEPARATE UPDATE under the GUC.
 * A crash before (c) leaves `pii_blob_purged_at` NULL → the next sweep
 * RE-SELECTS the row (redacted-but-unpurged arm of the predicate) and retries
 * the purge. The snapshot is already tombstoned, so the retry re-exposes no PII
 * and does NOT re-emit the audit; the purge simply lands on a later tick.
 *
 * Membership invoices are NOT touched here: their buyer is a real F3 member
 * (member_id IS NOT NULL) whose PII retention is governed by the F3/F9
 * member-lifecycle + GDPR-export surfaces, not this event-buyer sweeper.
 *
 * ── Immutability-trigger bypass (the sensitive part) ───────────────────────
 * `invoices_enforce_immutability` (migration 0019, amended 0205 + 0206) locks
 * `member_identity_snapshot` + `pii_blob_purged_at` the moment a row leaves
 * `draft`. To erase the buyer PII this cron sets the session GUC
 * `app.allow_pii_redaction = 'true'` via `SET LOCAL` INSIDE its per-tenant tx
 * (auto-resets at tx end, mirroring the `app.current_tenant` GUC in
 * `runInTenant`). The amended trigger then permits ONLY `member_identity_snapshot`
 * AND `pii_blob_purged_at` to change under that GUC — every other snapshot /
 * numbering / financial / event-discriminator column still RAISES if touched.
 * No other code path sets this GUC.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * The eligibility predicate matches a row that is EITHER still un-redacted
 * (`legal_name <> '[REDACTED]'`) OR redacted-but-purge-incomplete
 * (`legal_name = '[REDACTED]' AND pii_blob_purged_at IS NULL` with a blob key
 * still present). A fully-redacted-and-purged row (`pii_blob_purged_at` set)
 * is excluded, so re-running the cron only ever (re-)processes work that is not
 * yet complete. retry-OFF on cron-job.org: the daily tick is the natural retry.
 *
 * ── Cross-tenant sweep ─────────────────────────────────────────────────────
 * Iterates every tenant that has invoice settings (the only tenants that can
 * own event invoices), mirroring the F5 `sweep-stale-pending-refunds`
 * tenant-list pattern. The cross-tenant SELECT of the tenant list bypasses
 * RLS intentionally (owner role, no `app.current_tenant` set) — it is a
 * maintenance path gated by `CRON_SECRET`, not a user request. Each tenant's
 * data mutation runs inside `runInTenant` so RLS + the tenant GUC apply.
 *
 * Authentication: Bearer `CRON_SECRET` (constant-time `verifyCronBearer`),
 * matching the sibling F4 `sweep-stale-pending-refunds` cron.
 *
 * Returns 200 `{ ok, redactedCount, tenantsSwept, tenantsErrored }` (NO PII).
 * Per-tenant failures are logged + skipped so one bad tenant cannot block the
 * rest; the audit/metric trail (not the HTTP status) is the alerting anchor.
 *
 * Runbook: `docs/runbooks/cron-jobs.md` § F4 redact-expired-event-buyers.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { asTenantContext } from '@/modules/tenants';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import {
  applyRedactionOutcome,
  purgeBuyerPdfBlobsAndStampMarker,
  redactionMaxPerTick,
  tombstoneBuyerPiiAndAuditInTx,
  type RedactionPurgeWorkItem,
} from '@/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step';

// Cron path: cross-tenant read + per-tenant mutation. No top-level
// Application use case exists for cross-tenant orchestration — it is a
// maintenance path, not a user flow. Documented escape hatch (mirrors the
// sibling F5 sweep-stale-pending-refunds + F6 pseudonymise-eventcreate crons).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/redact-expired-event-buyers';

interface EligibleRow {
  readonly invoice_id: string;
  /** Issued invoice PDF blob key (prints the buyer PII). May be null pre-render. */
  readonly pdf_blob_key: string | null;
  /** Issued receipt PDF blob key — null for combined-mode / unpaid rows. */
  readonly receipt_pdf_blob_key: string | null;
  /**
   * Whether this row was ALREADY tombstoned on a prior pass (the redacted-but-
   * unpurged retry case). When true the cron skips the tombstone UPDATE + audit
   * and only retries the blob purge. Derived from the snapshot's `legal_name`.
   */
  readonly already_tombstoned: boolean;
}

/**
 * A NON-MEMBER event-invoice credit note eligible for the §87/3 sweep. A credit
 * note has NO `member_id`, so eligibility joins via `original_invoice_id →
 * invoices(member_id IS NULL, invoice_subject='event')`. The 10y anchor is the
 * CN's OWN `issue_date` (its own §86/10 tax document). `pdf_blob_key` is NOT NULL
 * on credit notes (one PDF). See {@link EligibleRow.already_tombstoned}.
 */
interface EligibleNonMemberCreditNoteRow {
  readonly credit_note_id: string;
  /** Issued credit-note PDF blob key (prints the buyer PII). NOT NULL on credit notes. */
  readonly pdf_blob_key: string;
  /** The parent invoice this credit note credits — the join axis. */
  readonly original_invoice_id: string;
  readonly already_tombstoned: boolean;
}

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId, route: ROUTE }, 'cron.redact_expired_event_buyers.unauthorized');
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // Tenant list — every tenant that has invoice settings can own event
  // invoices. Reads bypass tenant RLS (owner role, no app.current_tenant)
  // intentionally — cross-tenant ops surface gated by CRON_SECRET.
  let tenantSlugs: string[] = [];
  try {
    const rows = (await db.execute(sql`
      SELECT tenant_id FROM tenant_invoice_settings
    `)) as unknown as Array<{ tenant_id: string }>;
    tenantSlugs = rows.map((r) => r.tenant_id);
  } catch (e) {
    // errKind/constructor name only — a Postgres error message can carry SQL
    // fragments / column values (forbidden-fields hygiene).
    logger.error(
      { requestId, route: ROUTE, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
      'cron.redact_expired_event_buyers.tenant_list_failed',
    );
    return NextResponse.json({ error: { code: 'tenant_list_failed' } }, { status: 500 });
  }

  let redactedCount = 0;
  let tenantsSwept = 0;
  let tenantsErrored = 0;

  // FIX #6 — per-tick eligibility cap (default 50, env-overridable). Read ONCE
  // per request so every tenant's two SELECTs use the same bound this tick.
  const maxPerTick = redactionMaxPerTick();

  for (const tenantSlug of tenantSlugs) {
    try {
      const ctx = asTenantContext(tenantSlug);
      const redactedResult = await runInTenant(ctx, async (tx) => {
        // Authorise the buyer-PII tombstone + purge-marker writes for THIS tx
        // only. SET LOCAL auto-resets at tx end; the amended trigger (0205 +
        // 0206) lets ONLY member_identity_snapshot AND pii_blob_purged_at change
        // while this is 'true'.
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);

        // Eligible (HIGH-3 retryable predicate): a non-member event invoice,
        // issued (any non-draft), older than 10 years, with a non-null buyer
        // snapshot, that is EITHER
        //   (1) still UN-REDACTED (legal_name <> '[REDACTED]'), OR
        //   (2) REDACTED-BUT-PURGE-INCOMPLETE (legal_name = '[REDACTED]' AND
        //       pii_blob_purged_at IS NULL with a blob key still present) — i.e.
        //       a row whose DB tombstone committed on a prior pass but whose PDF
        //       byte purge did not complete (crash / Blob outage between commit
        //       and purge). `already_tombstoned` distinguishes the two so case
        //       (2) skips the tombstone UPDATE + audit and only retries the purge.
        // A fully-redacted-and-purged row (pii_blob_purged_at set) is excluded.
        // RLS scopes the read to this tenant (chamber_app role + GUC).
        //
        // FIX 1 (round-2) — `FOR UPDATE SKIP LOCKED`: under two concurrent cron
        // instances the eligibility windows can overlap. Locking the selected
        // rows FOR UPDATE and SKIPPING any a sibling instance already holds means
        // each row is processed by AT MOST ONE instance per tick — eliminating
        // the contended path entirely. The tombstone UPDATE's RETURNING-rowcount
        // gate below is the authoritative audit-once guarantee even if a row is
        // somehow seen by both (SKIP LOCKED is the cheap first line of defence).
        const eligible = (await tx.execute(sql`
          SELECT
            invoice_id,
            pdf_blob_key,
            receipt_pdf_blob_key,
            (member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
          FROM invoices
          WHERE invoice_subject = 'event'
            AND member_id IS NULL
            AND status <> 'draft'
            AND issue_date < (now() - interval '10 years')::date
            AND member_identity_snapshot IS NOT NULL
            AND (
              (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
              OR (
                (member_identity_snapshot->>'legal_name') = '[REDACTED]'
                AND pii_blob_purged_at IS NULL
                AND (pdf_blob_key IS NOT NULL OR receipt_pdf_blob_key IS NOT NULL)
              )
            )
          LIMIT ${maxPerTick}
          FOR UPDATE SKIP LOCKED
        `)) as unknown as EligibleRow[];

        let tenantRedacted = 0;
        // Work items whose PDF BYTES must be erased once this tx commits.
        // Collected inside the tx (so we only ever purge bytes for a tombstone
        // that is durable) and acted on AFTER commit — never inside the tx, so a
        // blob-side hiccup can't dirty / roll back the DB erasure.
        const purgeWork: RedactionPurgeWorkItem[] = [];
        for (const row of eligible) {
          // The issued tax-document PDF(s) carry the same buyer PII in print.
          // Collect their KEYS (receipt key may be null) — these are the bytes
          // to erase + the forensic record of WHAT was purged. Keys are path
          // segments (tenant/doc-id), not PII values.
          const blobKeys = [row.pdf_blob_key, row.receipt_pdf_blob_key].filter(
            (k): k is string => Boolean(k),
          );

          // Per-row tombstone + audit (shared with the member-invoice cron via
          // `redact-buyer-pii-step`). The helper returns the post-commit purge
          // work item (or null for a lost concurrency race / a fresh zero-blob
          // row already fully redacted). FIX #8 — `auditPayloadExtra:
          // { document_kind: 'invoice' }` makes the audit row SELF-DESCRIBING
          // (invoice-vs-credit_note) without inferring from the id-column key.
          // It carries NO `member_id` — a non-member event buyer has no member,
          // so the redaction stays OUT of the per-member F3 timeline / erasure-
          // evidence arm (which keys on `payload.member_id`). RETURNING-gated
          // audit-once + zero-blob inline-marker + jsonb-shape preservation all
          // live in the helper.
          const outcome = await tombstoneBuyerPiiAndAuditInTx({
            tx,
            documentTable: 'invoices',
            documentId: row.invoice_id,
            blobKeys,
            alreadyTombstoned: row.already_tombstoned,
            audit: f4AuditAdapter,
            auditPayloadExtra: { document_kind: 'invoice' },
            tenantId: tenantSlug,
            requestId,
            route: ROUTE,
          });

          // 'tombstoned' is a fresh redaction (counted); 'retry' queues a purge
          // of an already-tombstoned row without counting; 'lost_race' does
          // nothing. A zero-blob fresh tombstone is unreachable here anyway. See
          // `applyRedactionOutcome` for the discriminated-union narrowing.
          tenantRedacted += applyRedactionOutcome(outcome, purgeWork);
        }

        // ── Non-member event credit-note arm (COMP-1 FIX-1) ──────────────────
        // A non-member event invoice's >10y credit note carries the SAME buyer
        // PII + §87/3 retention as its parent but was matched by NEITHER cron
        // (this cron had no CN arm; the member cron's CN arm requires
        // i.member_id IS NOT NULL). `credit_notes` has NO `member_id`, so join
        // via `original_invoice_id → invoices(member_id IS NULL,
        // invoice_subject='event')` — the INVERSE of the member cron's CN-arm
        // parent filter, keeping the two crons' responsibility axes disjoint
        // (this cron owns member_id IS NULL event buyers; the member cron owns
        // erased-member docs — no overlap, no double-redaction). The 10y anchor
        // is the CN's OWN `issue_date` (decision #1 — its own §86/10 tax
        // document with its own retention window). Runs in the SAME tx under the
        // SAME `app.allow_pii_redaction` GUC set above (which covers
        // credit_notes per migration 0227). `FOR UPDATE OF cn SKIP LOCKED`
        // locks only the credit-note rows.
        const eligibleCreditNotes = (await tx.execute(sql`
          SELECT
            cn.credit_note_id,
            cn.pdf_blob_key,
            cn.original_invoice_id,
            (cn.member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
          FROM credit_notes cn
          JOIN invoices i ON i.invoice_id = cn.original_invoice_id
          WHERE i.member_id IS NULL
            AND i.invoice_subject = 'event'
            AND cn.issue_date < (now() - interval '10 years')::date
            AND cn.member_identity_snapshot IS NOT NULL
            AND (
              (cn.member_identity_snapshot->>'legal_name') <> '[REDACTED]'
              OR (
                (cn.member_identity_snapshot->>'legal_name') = '[REDACTED]'
                AND cn.pii_blob_purged_at IS NULL
                AND cn.pdf_blob_key IS NOT NULL
              )
            )
          LIMIT ${maxPerTick}
          FOR UPDATE OF cn SKIP LOCKED
        `)) as unknown as EligibleNonMemberCreditNoteRow[];

        for (const row of eligibleCreditNotes) {
          // Credit notes carry exactly ONE PDF (pdf_blob_key is NOT NULL).
          const blobKeys = [row.pdf_blob_key];

          // FIX #8 — `auditPayloadExtra: { document_kind: 'credit_note' }` makes
          // the non-member CN audit row SELF-DESCRIBING while keeping it free of
          // any member discriminator — a non-member event buyer has NO member, so
          // `member_id` must NEVER appear (it would falsely surface in the F3
          // member timeline + erasure-evidence surfaces). This mirrors the
          // invoices arm in THIS cron. The helper records credit_note_id /
          // redacted_fields / blob keys itself.
          const outcome = await tombstoneBuyerPiiAndAuditInTx({
            tx,
            documentTable: 'credit_notes',
            documentId: row.credit_note_id,
            blobKeys,
            alreadyTombstoned: row.already_tombstoned,
            audit: f4AuditAdapter,
            auditPayloadExtra: { document_kind: 'credit_note' },
            tenantId: tenantSlug,
            requestId,
            route: ROUTE,
          });

          tenantRedacted += applyRedactionOutcome(outcome, purgeWork);
        }

        return { tenantRedacted, purgeWork };
      });

      const { tenantRedacted: redactedThisTenant, purgeWork } = redactedResult;

      // Erase the PDF BYTES AFTER the tx committed, then — and ONLY on a fully
      // successful purge of every key for the row — stamp `pii_blob_purged_at`
      // in a SEPARATE GUC-gated UPDATE so the marker is durable proof the bytes
      // are gone. Best-effort + non-fatal per delete: the DB tombstone
      // (authoritative copy) is already durable, so a blob failure must NOT undo
      // it — bump the error metric, then carry on. If ANY key fails (or the
      // marker UPDATE fails), `pii_blob_purged_at` stays NULL → the NEXT sweep
      // RE-SELECTS this row (redacted-but-unpurged arm) and retries the purge.
      // No PII is re-exposed (snapshot already tombstoned) and the audit is NOT
      // re-emitted (already_tombstoned branch). The purge + marker logic is
      // shared with the member-invoice cron via `redact-buyer-pii-step`.
      for (const item of purgeWork) {
        await purgeBuyerPdfBlobsAndStampMarker({
          ctx,
          item,
          tenantId: tenantSlug,
          blobDelete: (k) => vercelBlobAdapter.delete(k),
          onPurged: (kind) =>
            // Observability (R1): label the completed purge so an operator can
            // tell a same-pass erase from a retry that recovered a previously
            // crashed redaction (the HIGH-3 crash-between-commit-and-purge case).
            logger.info(
              {
                requestId,
                route: ROUTE,
                tenantId: tenantSlug,
                invoiceId: item.documentId,
                purgeKind: kind,
              },
              'cron.redact_expired_event_buyers.blob_purged',
            ),
          onError: ({ documentId, errKind, phase }) => {
            invoicingMetrics.eventBuyerPiiRedacted('error', tenantSlug);
            // Restore the per-row forensic breadcrumb (errKind only — never the
            // error message, which can carry SQL fragments / blob keys). The
            // runbook greps these to find which invoice's purge is stuck.
            logger.error(
              { requestId, route: ROUTE, tenantId: tenantSlug, invoiceId: documentId, errKind },
              phase === 'blob_delete'
                ? 'cron.redact_expired_event_buyers.blob_delete_failed'
                : 'cron.redact_expired_event_buyers.purge_marker_failed',
            );
          },
        });
      }

      tenantsSwept += 1;
      redactedCount += redactedThisTenant;
      invoicingMetrics.eventBuyerPiiRedacted(
        redactedThisTenant > 0 ? 'redacted' : 'swept_zero',
        tenantSlug,
      );
      if (redactedThisTenant > 0) {
        logger.warn(
          { requestId, route: ROUTE, tenantId: tenantSlug, redacted: redactedThisTenant },
          'cron.redact_expired_event_buyers.tenant_redacted',
        );
      }
    } catch (e) {
      tenantsErrored += 1;
      invoicingMetrics.eventBuyerPiiRedacted('error', tenantSlug);
      logger.error(
        {
          requestId,
          route: ROUTE,
          tenantId: tenantSlug,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'cron.redact_expired_event_buyers.tenant_threw',
      );
    }
  }

  logger.info(
    { requestId, route: ROUTE, tenantsTotal: tenantSlugs.length, tenantsSwept, tenantsErrored, redactedCount },
    'cron.redact_expired_event_buyers.completed',
  );

  // Per cron-route convention (docs/runbooks/cron-jobs.md): per-tenant
  // failures degrade to `tenantsErrored > 0` in a 200 body; only scan-level
  // failures (auth, tenant-list query) return non-200. Alerting binds to the
  // `invoicing_event_buyer_pii_redacted_total{outcome=error}` counter.
  return NextResponse.json(
    { ok: true, redactedCount, tenantsSwept, tenantsErrored },
    { status: 200 },
  );
}
