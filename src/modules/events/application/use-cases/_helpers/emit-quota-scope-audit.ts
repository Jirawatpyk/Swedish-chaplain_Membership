/**
 * Phase 6 wave-5 REFACTOR H3 — shared per-scope quota audit emission
 * helper.
 *
 * Before this helper, `toggle-event-category.ts` contained ~150 LOC
 * of mirror-duplicated audit emission cascades: one block for the
 * partnership scope and a near-identical block for the cultural
 * scope, each with 3 branches (decremented / over_quota /
 * credit_back). The mirror invited bugs of the form "fixed
 * partnership but forgot cultural" — a real production hazard given
 * the FR-015 (per-event) vs FR-016 (per-year) semantics are subtly
 * different.
 *
 * This helper unifies the cascade by:
 *   1. Parameterizing on `scope: 'partnership' | 'cultural'` to pick
 *      the correct `eventType` per action
 *   2. Branching on `action` (decremented / over_quota / credit_back)
 *      to populate the canonical per-action payload shape
 *   3. Returning `Result<void, ToggleEventCategoryError>` where the
 *      err is the canonical `audit_emit_failed` discriminator so the
 *      caller can `return err(...)` directly without re-wrapping
 *
 * The helper preserves CRIT-2's invariant: `perEventAllotmentBefore =
 * allotmentAfter + 1` (and `annualAllotmentBefore` mirror) — caller
 * passes the already-correct `allotmentAfter` from the decision
 * branch, and the helper derives `before` consistently.
 *
 * Constitution Principle III: pure Application — no framework imports.
 */
import { ok, err, type Result } from '@/lib/result';
import type { MemberId } from '@/modules/members';
import type { UserId } from '@/modules/auth';
import type { EventId, RegistrationId } from '../../../domain/branded-types';
import type {
  ActorType,
  F6AuditPort,
  AuditEmitError,
} from '../../ports/audit-port';
import type { TenantId } from '@/modules/members';

export type QuotaScopeAction = 'decremented' | 'over_quota' | 'credit_back';

export interface BaseAuditEnvelope {
  readonly tenantId: TenantId;
  readonly actorType: ActorType;
  readonly actorUserId: UserId;
  readonly occurredAt: Date;
}

export interface EmitQuotaScopeAuditParams {
  readonly scope: 'partnership' | 'cultural';
  readonly action: QuotaScopeAction;
  readonly registrationId: RegistrationId;
  readonly memberId: MemberId;
  readonly eventId: EventId;
  /**
   * Pre-UPDATE-computed remaining allotment. For the `decremented`
   * branch the helper derives `before = allotmentAfter + 1`. For
   * `credit_back` the helper uses this value directly as
   * `allotmentAfter` in the payload. For `over_quota` the value is
   * unused (the audit payload has the literal `allotmentAtIngest: 0`).
   */
  readonly allotmentAfter: number;
  /** Required for cultural-scope `decremented` audits (annual scope). */
  readonly fiscalYear: number;
}

export type EmitAuditError = { readonly kind: 'audit_emit_failed'; readonly message: string };

/**
 * Emits one F6 audit row for the (scope, action) pair under the given
 * envelope. Returns `ok(undefined)` on success or
 * `err({kind:'audit_emit_failed', message})` if the audit-port write
 * fails (allowing the caller to bubble up via the strict-tx rollback).
 */
export async function emitQuotaScopeAudit(
  audit: F6AuditPort,
  baseAudit: BaseAuditEnvelope,
  params: EmitQuotaScopeAuditParams,
): Promise<Result<undefined, EmitAuditError>> {
  let result;
  switch (params.action) {
    case 'decremented':
      result = await emitDecremented(audit, baseAudit, params);
      break;
    case 'over_quota':
      result = await emitOverQuota(audit, baseAudit, params);
      break;
    case 'credit_back':
      result = await emitCreditBack(audit, baseAudit, params);
      break;
  }
  if (!result.ok) {
    return err({
      kind: 'audit_emit_failed',
      message: auditEmitErrorMessage(result.error),
    });
  }
  return ok(undefined);
}

function auditEmitErrorMessage(e: AuditEmitError): string {
  switch (e.kind) {
    case 'db_error':
      return e.message;
    case 'enum_value_unknown':
      return `audit enum unknown: ${e.eventType}`;
  }
}

async function emitDecremented(
  audit: F6AuditPort,
  baseAudit: BaseAuditEnvelope,
  p: EmitQuotaScopeAuditParams,
) {
  if (p.scope === 'partnership') {
    // CRIT-2 invariant preserved: `before = allotmentAfter + 1`.
    return audit.emit({
      ...baseAudit,
      eventType: 'quota_partnership_decremented',
      summary: `partnership decremented via toggle: registration ${p.registrationId} re-flagged after event toggle`,
      payload: {
        severity: 'info',
        registrationId: p.registrationId,
        memberId: p.memberId,
        eventId: p.eventId,
        perEventAllotmentBefore: p.allotmentAfter + 1,
        perEventAllotmentAfter: p.allotmentAfter,
      },
    });
  }
  return audit.emit({
    ...baseAudit,
    eventType: 'quota_cultural_decremented',
    summary: `cultural decremented via toggle: registration ${p.registrationId}`,
    payload: {
      severity: 'info',
      registrationId: p.registrationId,
      memberId: p.memberId,
      eventId: p.eventId,
      fiscalYear: p.fiscalYear,
      annualAllotmentBefore: p.allotmentAfter + 1,
      annualAllotmentAfter: p.allotmentAfter,
    },
  });
}

async function emitOverQuota(
  audit: F6AuditPort,
  baseAudit: BaseAuditEnvelope,
  p: EmitQuotaScopeAuditParams,
) {
  return audit.emit({
    ...baseAudit,
    eventType: 'quota_over_quota_warning',
    summary: `${p.scope} over-quota via toggle: registration ${p.registrationId}`,
    payload: {
      severity: 'warn',
      registrationId: p.registrationId,
      memberId: p.memberId,
      eventId: p.eventId,
      scope: p.scope,
      allotmentAtIngest: 0,
    },
  });
}

async function emitCreditBack(
  audit: F6AuditPort,
  baseAudit: BaseAuditEnvelope,
  p: EmitQuotaScopeAuditParams,
) {
  return audit.emit({
    ...baseAudit,
    eventType: 'quota_credit_back_archive',
    summary: `${p.scope} credit-back via toggle OFF: registration ${p.registrationId}`,
    payload: {
      severity: 'info',
      registrationId: p.registrationId,
      memberId: p.memberId,
      scope: p.scope,
      allotmentAfter: p.allotmentAfter,
    },
  });
}
