/**
 * T025 — `suppression-tenant-scoped` invariant (F7).
 *
 * Domain-layer guard: a `MarketingUnsubscribe` record's `tenantId` MUST
 * equal the tenant context resolving the lookup. FR-018 + Q8 invariant.
 *
 * Defence-in-depth: the DB enforces tenant scoping via Postgres RLS
 * (`USING (tenant_id = current_setting('app.current_tenant', TRUE))`).
 * This invariant catches any in-memory mutation OR cross-tenant probe
 * that slipped past the bypass-context window in the webhook /
 * unsubscribe routes (where RLS is briefly bypassed for signature/token
 * verification before re-binding to the resolved tenant).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { MarketingUnsubscribe } from '../marketing-unsubscribe';

export type SuppressionTenantScopeError = {
  readonly kind: 'suppression.tenant_mismatch';
  readonly recordTenantId: string;
  readonly expectedTenantId: string;
};

/**
 * Verify that a suppression record belongs to the expected tenant.
 * Use BEFORE acting on the record (e.g., before sending email,
 * before exposing it in admin UI).
 */
export function enforceSuppressionTenantScoped(
  record: MarketingUnsubscribe,
  expectedTenantId: string,
): Result<true, SuppressionTenantScopeError> {
  if (record.tenantId !== expectedTenantId) {
    return err({
      kind: 'suppression.tenant_mismatch',
      recordTenantId: record.tenantId,
      expectedTenantId,
    });
  }
  return ok(true);
}
