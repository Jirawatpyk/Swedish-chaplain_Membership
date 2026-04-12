/**
 * `update-fee-config` use case (T145, US5 FR-017, critique R1).
 *
 * Admin edits the tenant's fee config row. Editable fields: `vat_rate`
 * and `registration_fee_minor_units`. `currency_code` is immutable in
 * F2 once any non-deleted plan exists for the tenant (critique R1).
 *
 * Flow:
 *   1. Load current fee config via `feeConfigRepo.findByTenant`.
 *      Missing row → `not_found` (bootstrap error).
 *   2. Validate patch via zod (vat_rate ∈ [0, 1), registration_fee
 *      non-negative integer) → 400 `invalid_body` on failure.
 *   3. If `patch.currency_code` is present AND differs from current:
 *      a. Call `planRepo.countActiveForTenant`.
 *      b. If count > 0 → err `currency_code_immutable_in_f2` with
 *         current/attempted/count so the route can emit the 422
 *         response specified in contracts/plans-api.md § 13.
 *      c. If count === 0 → treat currency change as allowed, fall
 *         through to repo upsert (re-upsert because `update()` only
 *         touches vat_rate + registration_fee_minor_units).
 *   4. If `patch.currency_code` is present AND equals current: silently
 *      drop it from the patch (no diff, no error — plans-api.md § 13).
 *   5. If the patch has no effective changes after guarding, return
 *      the existing row as-is (idempotent no-op, no audit).
 *   6. Call `feeConfigRepo.update(patch)` for vat_rate /
 *      registration_fee changes, OR `upsert` when currency changes.
 *   7. Append `fee_config_updated` audit event with diff containing
 *      only the changed fields.
 *
 * **Audit-as-use-case-failure** — audit write failure propagates.
 */

import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { TenantContext } from '@/modules/tenants';
import { SUPPORTED_CURRENCIES } from '../domain/money';
import type {
  AuditPort,
  ClockPort,
  FeeConfigRepo,
  MemberAttachmentChecker,
  PlanRepo,
} from './ports';
import { recordAuditEvent } from './record-audit-event';
import type { TenantFeeConfig } from '../domain/fee-config';

// Editable subset (no currency_code — that's handled separately by the
// immutability guard below).
const feeConfigPatchSchema = z
  .object({
    vat_rate: z.number().min(0).max(0.9999, 'vat_rate must be in [0, 1)').optional(),
    registration_fee_minor_units: z
      .number()
      .int('registration_fee_minor_units must be an integer')
      .nonnegative('registration_fee_minor_units must be ≥ 0')
      .optional(),
    currency_code: z.enum(SUPPORTED_CURRENCIES, {
      errorMap: () => ({ message: 'currency_code must be a supported ISO 4217 code' }),
    }).optional(),
  })
  .strict();

/** Typed patch shape matching the zod schema above. */
export type FeeConfigPatchInput = {
  readonly vat_rate?: number;
  readonly registration_fee_minor_units?: number;
  readonly currency_code?: string;
};

export type UpdateFeeConfigInput = {
  readonly patch: FeeConfigPatchInput;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type UpdateFeeConfigError =
  | { readonly type: 'not_found' }
  | { readonly type: 'invalid_body'; readonly issues: readonly string[] }
  | {
      readonly type: 'currency_code_immutable_in_f2';
      readonly current_currency_code: string;
      readonly attempted_currency_code: string;
      readonly non_deleted_plan_count: number;
    }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type UpdateFeeConfigDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function updateFeeConfig(
  input: UpdateFeeConfigInput,
  deps: UpdateFeeConfigDeps,
): Promise<Result<TenantFeeConfig, UpdateFeeConfigError>> {
  // 1. Load current fee config
  let current: TenantFeeConfig | undefined;
  try {
    current = await deps.feeConfigRepo.findByTenant(deps.tenant);
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!current) return err({ type: 'not_found' });

  // 2. Validate patch
  const parsed = feeConfigPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`,
      ),
    });
  }
  const patch = parsed.data;

  // 3. Currency immutability guard (critique R1)
  let currencyChanged = false;
  if (patch.currency_code !== undefined) {
    if (patch.currency_code === current.currency_code) {
      // Silent no-op per plans-api.md § 13 — drop from patch.
    } else {
      // Currency actually differs — run the plan-count guard.
      let count: number;
      try {
        count = await deps.planRepo.countActiveForTenant(deps.tenant);
      } catch (e) {
        return err({
          type: 'server_error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
      if (count > 0) {
        return err({
          type: 'currency_code_immutable_in_f2',
          current_currency_code: current.currency_code,
          attempted_currency_code: patch.currency_code,
          non_deleted_plan_count: count,
        });
      }
      currencyChanged = true;
    }
  }

  // 4. Compute the diff — only include fields that actually changed
  const diff: import('../domain/audit-event').MutableAuditDiff = {};
  if (patch.vat_rate !== undefined && patch.vat_rate !== current.vat_rate) {
    diff.vat_rate = { before: current.vat_rate, after: patch.vat_rate };
  }
  if (
    patch.registration_fee_minor_units !== undefined &&
    patch.registration_fee_minor_units !== current.registration_fee_minor_units
  ) {
    diff.registration_fee_minor_units = {
      before: current.registration_fee_minor_units,
      after: patch.registration_fee_minor_units,
    };
  }
  if (currencyChanged) {
    diff.currency_code = {
      before: current.currency_code,
      after: patch.currency_code,
    };
  }

  // 5. Idempotent no-op when patch has no effective changes
  if (Object.keys(diff).length === 0) {
    return ok(current);
  }

  // 6. Persist
  let updated: TenantFeeConfig | undefined;
  try {
    updated = await deps.feeConfigRepo.update(
      deps.tenant,
      {
        ...(patch.vat_rate !== undefined ? { vat_rate: patch.vat_rate } : {}),
        ...(patch.registration_fee_minor_units !== undefined
          ? { registration_fee_minor_units: patch.registration_fee_minor_units }
          : {}),
        ...(currencyChanged ? { currency_code: patch.currency_code! } : {}),
      },
      input.actorUserId,
    );
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!updated) return err({ type: 'not_found' });

  // 7. Audit
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'fee_config_updated',
      payload: { diff },
    },
  );
  if (!auditResult.ok) {
    return err({
      type: 'audit_failed',
      message:
        auditResult.error.type === 'invalid_payload'
          ? auditResult.error.issues.join('; ')
          : auditResult.error.message,
    });
  }

  return ok(updated);
}
