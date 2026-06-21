/**
 * POST `/api/cron/invoicing/redact-expired-member-invoices`
 *
 * COMP-1 US3-B — 10-year ERASED-member tax-document PII-redaction sweep
 * (invoice arm + credit-note arm).
 *
 * GDPR Art.17 / PDPA §33 give a member the right to erasure. When a member is
 * erased (US1/US2), their LIVE F3 rows + dependent records are scrubbed
 * immediately — but their issued F4 tax documents (membership invoices AND
 * matched-member EVENT invoices) must be RETAINED 10 years under Thai RD §87/3.
 * Those documents carry the member's buyer PII in `member_identity_snapshot`
 * and on the issued §86/4 PDF. Once the statutory retention window elapses,
 * GDPR Art. 5(1)(e) (storage limitation) + Art. 17 require that retained copy's
 * PII be minimised too. This cron completes the erasure for the held tax copy:
 * it tombstones JUST the buyer-PII column — preserving every financial /
 * §87-numbering field the statutory record + any RD audit still need — purges
 * the issued PDF BYTES, and emits `event_buyer_pii_redacted` with a member
 * discriminator (`member_id` + `document_kind:'invoice'`).
 *
 * ── Eligibility (the gap-closing detail) ───────────────────────────────────
 * An invoice is eligible when it has `member_id IS NOT NULL` JOINED to a member
 * whose `erased_at IS NOT NULL`, is non-draft, and is >10 years past issue. The
 * gate keys on `member_id IS NOT NULL` (NOT `invoice_subject='membership'`), so
 * a MATCHED-MEMBER EVENT invoice (`invoice_subject='event' AND member_id IS NOT
 * NULL`) is ALSO redacted — it carries the erased member's buyer PII and would
 * otherwise fall in the gap between the two crons (the event-buyer cron handles
 * only `member_id IS NULL` non-member event buyers). A NON-erased member's
 * invoices are left intact: the relationship is live and that member's PII is
 * governed by the F3/F9 member lifecycle, not this erasure sweeper.
 *
 * ── Shared mechanism ───────────────────────────────────────────────────────
 * The per-row redaction step (GUC-gated tombstone UPDATE + RETURNING-gated
 * audit-once + retryable post-commit blob purge with the `pii_blob_purged_at`
 * marker) is the SAME reviewed implementation the event-buyer cron uses,
 * extracted to `redact-buyer-pii-step` and parameterized by `documentTable`.
 * The arm-specific eligible-QUERY (the `members` join) stays here. The
 * credit-note arm reuses the SAME helper with `documentTable:'credit_notes'`;
 * credit notes have NO `member_id` so they join via `original_invoice_id →
 * invoices.member_id → members.erased_at`, and their 10y anchor is the credit
 * note's OWN `issue_date` (its own §86/10 tax document, own retention window).
 *
 * ── Immutability-trigger bypass (the sensitive part) ───────────────────────
 * `invoices_enforce_immutability` (migrations 0019/0205/0206) locks
 * `member_identity_snapshot` + `pii_blob_purged_at` the moment a row leaves
 * draft. This cron sets `SET LOCAL app.allow_pii_redaction = 'true'` INSIDE its
 * per-tenant tx (auto-resets at tx end) so the amended trigger permits ONLY
 * those two columns to change — every other snapshot / numbering / financial
 * column still RAISES. No other code path sets this GUC.
 *
 * ── RLS / tenant isolation (Principle I) ───────────────────────────────────
 * The cross-tenant tenant-list SELECT bypasses RLS intentionally (owner role,
 * no `app.current_tenant`) — a maintenance path gated by `CRON_SECRET`, not a
 * user request. Each tenant's mutation runs inside `runInTenant`, so RLS scopes
 * BOTH `invoices` AND the joined `members` (both RLS+FORCE) to that tenant — the
 * join cannot cross tenants. The per-tenant body is extracted into the exported
 * `redactExpiredMemberDocumentsForTenant` so the cross-tenant isolation
 * integration test can drive the REAL code path for ONE tenant and assert a
 * second tenant's rows are untouched (the Review-Gate blocker).
 *
 * Authentication: Bearer `CRON_SECRET` (constant-time `verifyCronBearer`).
 * Returns 200 `{ ok, redactedCount, tenantsSwept, tenantsErrored }` (NO PII).
 * Per-tenant failures are logged + skipped so one bad tenant cannot block the
 * rest; the audit/metric trail (not the HTTP status) is the alerting anchor.
 *
 * Runbook: `docs/runbooks/cron-jobs.md` § redact-expired-member-invoices.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { f4AuditAdapter } from '@/modules/invoicing/infrastructure/adapters/audit-adapter';
import { vercelBlobAdapter } from '@/modules/invoicing/infrastructure/adapters/vercel-blob-adapter';
import {
  applyRedactionOutcome,
  purgeBuyerPdfBlobsAndStampMarker,
  redactionMaxPerTick,
  tombstoneBuyerPiiAndAuditInTx,
  type RedactionPurgeWorkItem,
} from '@/modules/invoicing/infrastructure/redaction/redact-buyer-pii-step';

// Cron path: cross-tenant read + per-tenant mutation. No top-level Application
// use case exists for cross-tenant orchestration — it is a maintenance path,
// not a user flow (documented escape hatch; mirrors the sibling F4
// redact-expired-event-buyers + F5 sweep-stale-pending-refunds crons).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/redact-expired-member-invoices';

interface EligibleInvoiceRow {
  readonly invoice_id: string;
  /** Issued invoice PDF blob key (prints the buyer PII). May be null pre-render. */
  readonly pdf_blob_key: string | null;
  /** Issued receipt PDF blob key — null for combined-mode / unpaid rows. */
  readonly receipt_pdf_blob_key: string | null;
  /** The erased member this invoice belongs to (audit discriminator). */
  readonly member_id: string;
  /** Audit discriminator (matched-member event = the gap case). Mirrors the
   * `invoice_subject` pg enum (`['membership','event']`, schema-invoices.ts:46). */
  readonly invoice_subject: 'membership' | 'event';
  /**
   * Whether this row was ALREADY tombstoned on a prior pass (the redacted-but-
   * unpurged retry case). When true the cron skips the tombstone UPDATE + audit
   * and only retries the blob purge. Derived from the snapshot's `legal_name`.
   */
  readonly already_tombstoned: boolean;
}

interface EligibleCreditNoteRow {
  readonly credit_note_id: string;
  /** Issued credit-note PDF blob key (prints the buyer PII). NOT NULL on credit notes. */
  readonly pdf_blob_key: string;
  /** The parent invoice this credit note credits — the join axis + audit discriminator. */
  readonly original_invoice_id: string;
  /** The erased member, resolved via the parent invoice (credit_notes has no member_id). */
  readonly member_id: string;
  /** See {@link EligibleInvoiceRow.already_tombstoned}. */
  readonly already_tombstoned: boolean;
}

/**
 * Redact every eligible (erased-member, >10y) invoice for ONE tenant. Runs the
 * GUC-gated tombstone+audit loop inside `runInTenant` (so RLS scopes both
 * `invoices` and the joined `members` to this tenant), then performs the
 * post-commit PDF-byte purge + marker stamp for each tombstoned row.
 *
 * Exported + independently callable so the cross-tenant RLS isolation
 * integration test (Task 5) can drive the REAL code path for tenant A and
 * assert tenant B's rows are untouched. Returns `{ redacted }` = the number of
 * rows freshly tombstoned on THIS pass (not retry-purges of already-tombstoned
 * rows). Throws on a DB-level failure (the route's per-tenant try/catch
 * isolates one bad tenant from the rest).
 */
export async function redactExpiredMemberDocumentsForTenant(
  ctx: TenantContext,
  requestId: string | null,
): Promise<{ redacted: number }> {
  const tenantSlug = ctx.slug;

  // FIX #6 — per-tick eligibility cap (default 50, env-overridable). Bounds each
  // arm's SELECT so a large >10y backlog cannot exceed `maxDuration` in one tick;
  // `SKIP LOCKED` + the cron's re-ticks drain the rest. Read once per tenant pass.
  const maxPerTick = redactionMaxPerTick();

  const { tenantRedacted, purgeWork } = await runInTenant(ctx, async (tx) => {
    // Authorise the buyer-PII tombstone + purge-marker writes for THIS tx only.
    // SET LOCAL auto-resets at tx end; the amended trigger lets ONLY
    // member_identity_snapshot AND pii_blob_purged_at change while this is 'true'.
    await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);

    // Eligible: an ERASED member's non-draft invoice, >10y past issue, with a
    // non-null buyer snapshot, that is EITHER still un-redacted OR redacted-but-
    // purge-incomplete (the HIGH-3 retryable arm). The `JOIN members` keys on
    // `member_id IS NOT NULL` + `erased_at IS NOT NULL` — covering BOTH
    // membership AND matched-member EVENT invoices (the gap case). RLS scopes
    // the read (both tables) to this tenant. `FOR UPDATE OF i SKIP LOCKED`
    // locks only the invoice rows (not the joined member rows) and skips any a
    // sibling cron instance already holds — each row is processed by at most one
    // instance per tick; the tombstone UPDATE's RETURNING gate is the
    // authoritative audit-once guarantee.
    const eligible = (await tx.execute(sql`
      SELECT
        i.invoice_id,
        i.pdf_blob_key,
        i.receipt_pdf_blob_key,
        i.member_id,
        i.invoice_subject,
        (i.member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
      FROM invoices i
      JOIN members m ON m.member_id = i.member_id AND m.erased_at IS NOT NULL
      WHERE i.member_id IS NOT NULL
        AND i.status <> 'draft'
        AND i.issue_date < (now() - interval '10 years')::date
        AND i.member_identity_snapshot IS NOT NULL
        AND (
          (i.member_identity_snapshot->>'legal_name') <> '[REDACTED]'
          OR (
            (i.member_identity_snapshot->>'legal_name') = '[REDACTED]'
            AND i.pii_blob_purged_at IS NULL
            AND (i.pdf_blob_key IS NOT NULL OR i.receipt_pdf_blob_key IS NOT NULL)
          )
        )
      LIMIT ${maxPerTick}
      FOR UPDATE OF i SKIP LOCKED
    `)) as unknown as EligibleInvoiceRow[];

    let redacted = 0;
    const work: RedactionPurgeWorkItem[] = [];
    for (const row of eligible) {
      // The issued tax-document PDF(s) carry the same buyer PII in print.
      // Collect their KEYS (receipt key may be null) — these are the bytes to
      // erase + the forensic record of WHAT was purged. Keys are path segments
      // (tenant/doc-id), not PII values.
      const blobKeys = [row.pdf_blob_key, row.receipt_pdf_blob_key].filter(
        (k): k is string => Boolean(k),
      );

      // Per-row tombstone + audit (shared with the event-buyer cron). The
      // member discriminator (`member_id` + `document_kind:'invoice'` +
      // `invoice_subject`) lands in the audit payload so US3-D can join the
      // tax-redaction outcome per member.
      const outcome = await tombstoneBuyerPiiAndAuditInTx({
        tx,
        documentTable: 'invoices',
        documentId: row.invoice_id,
        blobKeys,
        alreadyTombstoned: row.already_tombstoned,
        audit: f4AuditAdapter,
        auditPayloadExtra: {
          member_id: row.member_id,
          document_kind: 'invoice',
          invoice_subject: row.invoice_subject,
        },
        tenantId: tenantSlug,
        requestId,
        route: ROUTE,
      });

      // 'tombstoned' counts even with zero blob keys (closes the old zero-blob
      // undercount); 'retry' queues a purge without counting; 'lost_race' does
      // nothing. See `applyRedactionOutcome` for the discriminated-union narrowing.
      redacted += applyRedactionOutcome(outcome, work);
    }

    // ── Credit-note arm ──────────────────────────────────────────────────────
    // An erased member's >10y credit notes carry the SAME buyer PII + the SAME
    // §87/3 retention as their invoices. `credit_notes` has NO `member_id`, so
    // eligibility joins via `original_invoice_id → invoices.member_id →
    // members.erased_at`. The 10y anchor is the credit note's OWN `issue_date`
    // (decision #1 — it is its own §86/10 tax document with its own retention
    // window, not the original invoice's date). Runs in the SAME tx under the
    // SAME `app.allow_pii_redaction` GUC set above, so one GUC covers both arms.
    // `FOR UPDATE OF cn SKIP LOCKED` locks only the credit-note rows.
    const eligibleCreditNotes = (await tx.execute(sql`
      SELECT
        cn.credit_note_id,
        cn.pdf_blob_key,
        cn.original_invoice_id,
        i.member_id,
        (cn.member_identity_snapshot->>'legal_name') = '[REDACTED]' AS already_tombstoned
      FROM credit_notes cn
      JOIN invoices i ON i.invoice_id = cn.original_invoice_id
      JOIN members m ON m.member_id = i.member_id AND m.erased_at IS NOT NULL
      WHERE i.member_id IS NOT NULL
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
    `)) as unknown as EligibleCreditNoteRow[];

    for (const row of eligibleCreditNotes) {
      // Credit notes carry exactly ONE PDF (pdf_blob_key is NOT NULL).
      const blobKeys = [row.pdf_blob_key];

      const outcome = await tombstoneBuyerPiiAndAuditInTx({
        tx,
        documentTable: 'credit_notes',
        documentId: row.credit_note_id,
        blobKeys,
        alreadyTombstoned: row.already_tombstoned,
        audit: f4AuditAdapter,
        auditPayloadExtra: {
          member_id: row.member_id,
          document_kind: 'credit_note',
          original_invoice_id: row.original_invoice_id,
        },
        tenantId: tenantSlug,
        requestId,
        route: ROUTE,
      });

      redacted += applyRedactionOutcome(outcome, work);
    }

    return { tenantRedacted: redacted, purgeWork: work };
  });

  // Erase the PDF BYTES AFTER the tx committed, then — and ONLY on a fully
  // successful purge of every key — stamp `pii_blob_purged_at` via a SEPARATE
  // GUC-gated UPDATE. Best-effort + non-fatal per delete: the DB tombstone is
  // already durable, so a blob failure must NOT undo it — bump the error metric,
  // carry on, and let the next sweep re-select + retry (snapshot already
  // tombstoned → no PII re-exposed, audit not re-emitted).
  for (const item of purgeWork) {
    await purgeBuyerPdfBlobsAndStampMarker({
      ctx,
      item,
      tenantId: tenantSlug,
      blobDelete: (k) => vercelBlobAdapter.delete(k),
      onPurged: (kind) =>
        logger.info(
          {
            requestId,
            route: ROUTE,
            tenantId: tenantSlug,
            documentId: item.documentId,
            purgeKind: kind,
          },
          'cron.redact_expired_member_invoices.blob_purged',
        ),
      onError: ({ documentId, errKind, phase }) => {
        invoicingMetrics.memberDocumentPiiRedacted('error', tenantSlug);
        // errKind only — never the error message, which can carry SQL fragments
        // / blob keys (forbidden-fields hygiene). The runbook greps these to find
        // which document's purge is stuck.
        logger.error(
          { requestId, route: ROUTE, tenantId: tenantSlug, documentId, errKind },
          phase === 'blob_delete'
            ? 'cron.redact_expired_member_invoices.blob_delete_failed'
            : 'cron.redact_expired_member_invoices.purge_marker_failed',
        );
      },
    });
  }

  return { redacted: tenantRedacted };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId, route: ROUTE }, 'cron.redact_expired_member_invoices.unauthorized');
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  // Tenant list — every tenant that has invoice settings can own member
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
      'cron.redact_expired_member_invoices.tenant_list_failed',
    );
    return NextResponse.json({ error: { code: 'tenant_list_failed' } }, { status: 500 });
  }

  let redactedCount = 0;
  let tenantsSwept = 0;
  let tenantsErrored = 0;

  for (const tenantSlug of tenantSlugs) {
    try {
      const ctx = asTenantContext(tenantSlug);
      const { redacted } = await redactExpiredMemberDocumentsForTenant(ctx, requestId);

      tenantsSwept += 1;
      redactedCount += redacted;
      invoicingMetrics.memberDocumentPiiRedacted(redacted > 0 ? 'redacted' : 'swept_zero', tenantSlug);
      if (redacted > 0) {
        logger.warn(
          { requestId, route: ROUTE, tenantId: tenantSlug, redacted },
          'cron.redact_expired_member_invoices.tenant_redacted',
        );
      }
    } catch (e) {
      tenantsErrored += 1;
      invoicingMetrics.memberDocumentPiiRedacted('error', tenantSlug);
      logger.error(
        {
          requestId,
          route: ROUTE,
          tenantId: tenantSlug,
          errKind: e instanceof Error ? e.constructor.name : 'unknown',
        },
        'cron.redact_expired_member_invoices.tenant_threw',
      );
    }
  }

  logger.info(
    { requestId, route: ROUTE, tenantsTotal: tenantSlugs.length, tenantsSwept, tenantsErrored, redactedCount },
    'cron.redact_expired_member_invoices.completed',
  );

  // Per cron-route convention: per-tenant failures degrade to
  // `tenantsErrored > 0` in a 200 body; only scan-level failures (auth,
  // tenant-list query) return non-200. Alerting binds to the
  // `member_document_pii_redacted_total{outcome=error}` counter.
  return NextResponse.json(
    { ok: true, redactedCount, tenantsSwept, tenantsErrored },
    { status: 200 },
  );
}
