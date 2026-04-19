/**
 * Fee config adapter — reads F2's `tenant_fee_config` via the plans
 * module's public `getFeeConfig` use case. Keeps F4 dependency on F2
 * limited to the public barrel — the Clean Architecture boundary is
 * preserved.
 */
import type {
  FeeConfigPort,
  TenantFeeConfigView,
} from '../../application/ports/fee-config-port';
import { getFeeConfig } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
import { asTenantContext } from '@/modules/tenants';

export const f2FeeConfigAdapter: FeeConfigPort = {
  async getByTenant(tenantId: string): Promise<TenantFeeConfigView | null> {
    const ctx = asTenantContext(tenantId);
    const deps = buildPlansDeps(ctx);
    const result = await getFeeConfig(deps);
    if (!result.ok) return null;
    return {
      currencyCode: result.value.currency_code,
      vatRate: result.value.vat_rate.toFixed(4),
      registrationFeeMinorUnits: BigInt(result.value.registration_fee_minor_units),
    };
  },
};
