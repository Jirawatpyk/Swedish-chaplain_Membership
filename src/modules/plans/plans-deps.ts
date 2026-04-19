/**
 * Plans module — composition root.
 *
 * This file wires every Infrastructure singleton (plan repo, fee
 * config repo, audit adapter, stub member checker) + the default
 * Clock into the `PlansDeps` dependency bag that Application use
 * cases receive. Presentation handlers import `buildPlansDeps(ctx)`
 * to get a fully-assembled deps object for a request.
 *
 * The `TenantContext` is passed per-request — the rest of the
 * infrastructure is module-level (stateless adapters over the shared
 * Drizzle client + Upstash Redis singleton).
 *
 * Tests construct their own `PlansDeps` inline with stubbed ports.
 * They never import this module — that's why it isn't re-exported
 * from the public barrel (index.ts).
 */

import type { TenantContext } from '@/modules/tenants';
import type { PlansDeps } from './application/ports';
import { planRepo } from './infrastructure/db/plan-repo';
import { feeConfigRepo } from './infrastructure/db/fee-config-repo';
import { planAuditAdapter } from './infrastructure/audit/plan-audit-adapter';
import { stubMemberAttachmentChecker } from './infrastructure/members/stub-member-attachment-checker';
import { getTenantTaxPolicy, makeGetTenantTaxPolicyDeps } from '@/modules/invoicing';

/**
 * Default system clock — wall-clock UTC. Tests override with a fake.
 */
const systemClock = {
  now: () => new Date(),
  currentYear: () => new Date().getUTCFullYear(),
};

/**
 * Build the default `PlansDeps` bag for a request-scoped tenant.
 *
 * Route handlers call this once per request:
 *
 *   import { buildPlansDeps } from '@/modules/plans/plans-deps';
 *   import { resolveTenantFromRequest } from '@/lib/tenant-context';
 *   import { listPlans } from '@/modules/plans';
 *
 *   export async function GET(req: NextRequest) {
 *     const deps = buildPlansDeps(resolveTenantFromRequest(req));
 *     const result = await listPlans(parsedQuery, deps);
 *     // ...
 *   }
 */
export function buildPlansDeps(tenant: TenantContext): PlansDeps {
  return {
    tenant,
    planRepo,
    feeConfigRepo,
    // R7 consolidation — cross-module composition: reads F4's
    // invoice_settings via the public `getTenantTaxPolicy` facade.
    // Adapts F4's `VatRate` + `currencyCode` view to the minimal
    // shape list-plans expects (raw 4-dp string + currency string).
    taxPolicy: async () => {
      const policy = await getTenantTaxPolicy(
        makeGetTenantTaxPolicyDeps(),
        tenant.slug,
      );
      if (!policy) return null;
      return {
        currencyCode: policy.currencyCode,
        vatRateRaw: policy.vatRate.raw,
      };
    },
    audit: planAuditAdapter,
    clock: systemClock,
    members: stubMemberAttachmentChecker,
  };
}
