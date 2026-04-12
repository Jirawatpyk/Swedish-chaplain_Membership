/**
 * `get-fee-config` use case (T144, US5 FR-017).
 *
 * Thin delegation over `feeConfigRepo.findByTenant`. Returns the
 * tenant's current fee config row, or `not_found` when no row exists
 * yet (bootstrap error — every tenant is expected to have exactly one
 * row seeded at onboarding).
 *
 * Read-only — no audit event, no idempotency key. Manager role may
 * call via the matching GET /api/fee-config route.
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { FeeConfigRepo } from './ports';
import type { TenantFeeConfig } from '../domain/fee-config';

export type GetFeeConfigError =
  | { readonly type: 'not_found' }
  | { readonly type: 'server_error'; readonly message: string };

export type GetFeeConfigDeps = {
  readonly tenant: TenantContext;
  readonly feeConfigRepo: FeeConfigRepo;
};

export async function getFeeConfig(
  deps: GetFeeConfigDeps,
): Promise<Result<TenantFeeConfig, GetFeeConfigError>> {
  try {
    const row = await deps.feeConfigRepo.findByTenant(deps.tenant);
    if (!row) return err({ type: 'not_found' });
    return ok(row);
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
