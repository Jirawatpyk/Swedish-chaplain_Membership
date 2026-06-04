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
 * Membership invoices are NOT touched here: their buyer is a real F3 member
 * (member_id IS NOT NULL) whose PII retention is governed by the F3/F9
 * member-lifecycle + GDPR-export surfaces, not this event-buyer sweeper.
 *
 * ── Immutability-trigger bypass (the sensitive part) ───────────────────────
 * `invoices_enforce_immutability` (migration 0019, amended 0205) locks
 * `member_identity_snapshot` the moment a row leaves `draft`. To erase the
 * buyer PII this cron sets the session GUC `app.allow_pii_redaction = 'true'`
 * via `SET LOCAL` INSIDE its per-tenant tx (auto-resets at tx end, mirroring
 * the `app.current_tenant` GUC in `runInTenant`). The amended trigger then
 * permits ONLY `member_identity_snapshot` to change under that GUC — every
 * other snapshot / numbering / financial column still RAISES if touched. No
 * other code path sets this GUC.
 *
 * ── Idempotency ────────────────────────────────────────────────────────────
 * The eligibility predicate excludes already-tombstoned rows
 * (`member_identity_snapshot->>'legal_name' <> '[REDACTED]'`), so re-running
 * the cron only ever processes still-unredacted rows. retry-OFF on
 * cron-job.org: the daily tick is the natural retry.
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

// Cron path: cross-tenant read + per-tenant mutation. No top-level
// Application use case exists for cross-tenant orchestration — it is a
// maintenance path, not a user flow. Documented escape hatch (mirrors the
// sibling F5 sweep-stale-pending-refunds + F6 pseudonymise-eventcreate crons).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ROUTE = '/api/cron/invoicing/redact-expired-event-buyers';

/** PII fields tombstoned on the buyer snapshot. NAMES only — never values. */
const REDACTED_FIELDS = [
  'legal_name',
  'address',
  'primary_contact_name',
  'primary_contact_email',
  'tax_id',
] as const;

interface EligibleRow {
  readonly invoice_id: string;
}

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

  for (const tenantSlug of tenantSlugs) {
    try {
      const ctx = asTenantContext(tenantSlug);
      const redactedThisTenant = await runInTenant(ctx, async (tx) => {
        // Authorise the buyer-PII tombstone for THIS tx only. SET LOCAL
        // auto-resets at tx end; the amended trigger (0205) lets ONLY
        // member_identity_snapshot change while this is 'true'.
        await tx.execute(sql`SET LOCAL app.allow_pii_redaction = 'true'`);

        // Eligible: non-member event invoice, issued (any non-draft), older
        // than 10 years, with a non-null buyer snapshot NOT already tombstoned.
        // RLS scopes the read to this tenant (chamber_app role + GUC).
        const eligible = (await tx.execute(sql`
          SELECT invoice_id
          FROM invoices
          WHERE invoice_subject = 'event'
            AND member_id IS NULL
            AND status <> 'draft'
            AND issue_date < (now() - interval '10 years')::date
            AND member_identity_snapshot IS NOT NULL
            AND (member_identity_snapshot->>'legal_name') <> '[REDACTED]'
        `)) as unknown as EligibleRow[];

        let tenantRedacted = 0;
        for (const row of eligible) {
          const redactedAt = new Date().toISOString();

          // Tombstone the buyer PII, preserving the jsonb STRUCTURE so the
          // non-draft snapshot CHECK (member_identity_snapshot IS NOT NULL)
          // still holds and the doc-type contract shape is intact. Only the
          // five PII fields change; every financial/numbering column is left
          // untouched (the trigger enforces this under the GUC).
          await tx.execute(sql`
            UPDATE invoices
            SET member_identity_snapshot = member_identity_snapshot
              || jsonb_build_object(
                   'legal_name', '[REDACTED]',
                   'address', '[REDACTED]',
                   'primary_contact_name', '[REDACTED]',
                   'primary_contact_email', '',
                   'tax_id', NULL
                 )
            WHERE invoice_id = ${row.invoice_id}
          `);

          // Audit in the SAME tx as the UPDATE — atomic: a rollback removes
          // both. NON-timeline payload (no member_id; the row has none).
          // Field NAMES only — never the erased PII values. 10y retention is
          // applied by the adapter via F4_AUDIT_RETENTION_YEARS.
          await f4AuditAdapter.emit(tx, {
            eventType: 'event_buyer_pii_redacted',
            // `audit_log.actor_user_id` is `text NOT NULL`; the sweeper has no
            // human actor → the project-wide cron sentinel (matches every other
            // cron route's emit).
            actorUserId: 'system:cron',
            summary: `Redacted buyer PII on expired non-member event invoice ${row.invoice_id}`,
            payload: {
              invoice_id: row.invoice_id,
              redacted_at: redactedAt,
              redacted_fields: [...REDACTED_FIELDS],
              reason: 'retention_10y_elapsed',
              route: ROUTE,
            },
            tenantId: tenantSlug,
            requestId,
          });

          tenantRedacted += 1;
        }
        return tenantRedacted;
      });

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
