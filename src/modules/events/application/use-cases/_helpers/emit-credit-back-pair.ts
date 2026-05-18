/**
 * R2-3 (2026-05-18 /speckit-review Round 2) — extracted helper for the
 * `quota_credit_back_refund` audit emit on a state-change debit (paid/
 * free → pending/waitlisted/no_show).
 *
 * Before extraction the same emit shape lived inline at the partnership-
 * scope and cultural-scope sites in `maybeApplyStateChange` (now
 * consolidated at the two `emitCreditBackViaStateChange(...)` calls in
 * `import-csv.ts`) — differing only by scope label + allotment delta.
 * Folding them through one helper prevents drift between the two
 * branches when the audit payload shape evolves.
 *
 * The helper deliberately does NOT loop over both scopes — callers
 * still gate each emit on `prev.countedAgainstPartnership` /
 * `prev.countedAgainstCulturalQuota` because each scope flag is
 * independently meaningful (a row may have been counted against one
 * scope but not the other).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { emitOrThrow } from './process-attendee-in-tx';
import type { UserId } from '@/modules/auth';
import type { TenantId, MemberId } from '@/modules/members';
import type { F6AuditPort } from '../../ports/audit-port';
import type { RegistrationId } from '../../../domain/branded-types';
import type { PaymentStatus } from '../../../domain/value-objects/payment-status';

export interface EmitCreditBackViaStateChangeArgs {
  readonly tenantId: TenantId;
  readonly actorUserId: UserId | null;
  readonly rowNumber: number;
  readonly registrationId: RegistrationId;
  readonly memberId: MemberId;
  readonly previousPaymentStatus: PaymentStatus;
  readonly newPaymentStatus: PaymentStatus;
  readonly scope: 'partnership' | 'cultural';
  readonly allotmentAfter: number;
}

/**
 * Emit a `quota_credit_back_refund` audit row for a state-change debit.
 * Reuses the canonical event type (semantically identical to the FR-018
 * refund credit-back); the `summary` disambiguates via the
 * `via state_change` literal so audit consumers can split the two
 * causes when needed.
 *
 * Throws `TxStageError('audit_emit', ...)` if the emitter rejects — the
 * outer SAVEPOINT then rolls back atomically per R2-1.
 */
export async function emitCreditBackViaStateChange(
  audit: F6AuditPort,
  args: EmitCreditBackViaStateChangeArgs,
): Promise<void> {
  await emitOrThrow(audit, {
    tenantId: args.tenantId,
    actorType: 'csv_import',
    actorUserId: args.actorUserId,
    occurredAt: new Date(),
    eventType: 'quota_credit_back_refund',
    summary: `${args.scope} credit-back via state_change: row ${args.rowNumber} ${args.previousPaymentStatus}→${args.newPaymentStatus}`,
    payload: {
      severity: 'info',
      registrationId: args.registrationId,
      memberId: args.memberId,
      scope: args.scope,
      allotmentAfter: args.allotmentAfter,
    },
  });
}
