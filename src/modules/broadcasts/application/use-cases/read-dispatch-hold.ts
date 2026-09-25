/**
 * F119 PR-A R1 — is this due E-Blast HELD for the member's payment?
 *
 * The staff detail page (`/admin/broadcasts/[id]`) shows a note on an
 * `approved` E-Blast whose `scheduled_for` has passed while the member's
 * membership is `suspended` (awaiting payment): the dispatch cron holds such a
 * row every tick — nothing sent, nothing written — until the cycle completes
 * (it sends) or lapses (it is refused). Without the note the row reads as an
 * overdue send with no explanation.
 *
 * It reads the SAME decision the dispatch legs act on
 * (`decideDispatchStanding`), so the note cannot say "held" while the cron
 * refuses, or the reverse. A read, not a gate: the cron re-decides every tick.
 *
 * Pure Application — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { BroadcastStatus } from '../../domain/value-objects/broadcast-status';
import type { ClockPort } from '../ports/clock-port';
import { decideDispatchStanding, type DispatchStandingDeps } from './_dispatch-standing-gate';

export interface ReadDispatchHoldDeps {
  readonly tenant: TenantContext;
  readonly sendStanding: DispatchStandingDeps;
  readonly clock: ClockPort;
}

export interface ReadDispatchHoldInput {
  readonly status: BroadcastStatus;
  readonly scheduledFor: Date | null;
  /** `broadcasts.requested_by_member_id`. */
  readonly memberId: string;
}

export type ReadDispatchHoldError = { readonly kind: 'server_error'; readonly errClass: string };

export async function readDispatchHold(
  deps: ReadDispatchHoldDeps,
  input: ReadDispatchHoldInput,
): Promise<Result<boolean, ReadDispatchHoldError>> {
  // Only a row the cron would claim can be held — and only such a row pays
  // for the two standing reads.
  const due =
    input.status === 'approved' &&
    input.scheduledFor !== null &&
    input.scheduledFor.getTime() <= deps.clock.now().getTime();
  if (!due) return ok(false);

  const decision = await decideDispatchStanding(deps.sendStanding, deps.tenant, input.memberId);
  if (decision.kind === 'undecided') return err({ kind: 'server_error', errClass: decision.errClass });
  return ok(decision.kind === 'hold');
}
