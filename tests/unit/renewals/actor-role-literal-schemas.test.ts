/**
 * 016 post-ship review finding #3 — the 14 renewals mutation schemas must
 * accept the LITERAL staff role their `renewals.write` gate admits.
 *
 * Pre-fix every one of these pinned `actorRole: z.literal('admin')`, so the
 * routes had to fabricate 'admin' for promoted super_admins — a false
 * actor_role persisted into append-only money-path audit rows whose contract
 * (renewal-audit-emitter `actor_role`) promises the literal role. This pins
 * the corrected shape ON THE SCHEMA so a future route can pass the truth,
 * and pins the exclusions so the widening never drifts into roles the gate
 * does not admit (manager / marketing / member).
 */
import { describe, expect, it } from 'vitest';
import { adminReactivateLapsedCycleInputSchema } from '@/modules/renewals/application/use-cases/admin-reactivate-lapsed-cycle';
import { escalateTierUpgradeInputSchema } from '@/modules/renewals/application/use-cases/escalate-tier-upgrade';
import { acceptTierUpgradeInputSchema } from '@/modules/renewals/application/use-cases/accept-tier-upgrade';
import { blockAutoReactivationInputSchema } from '@/modules/renewals/application/use-cases/block-auto-reactivation';
import { dismissTierUpgradeInputSchema } from '@/modules/renewals/application/use-cases/dismiss-tier-upgrade';
import { adminRenewLapsedMemberInputSchema } from '@/modules/renewals/application/use-cases/admin-renew-lapsed-member';
import { adminRejectReactivationInputSchema } from '@/modules/renewals/application/use-cases/admin-reject-reactivation';
import { completeEscalationTaskInputSchema } from '@/modules/renewals/application/use-cases/complete-escalation-task';
import { reassignEscalationTaskInputSchema } from '@/modules/renewals/application/use-cases/reassign-escalation-task';
import { unblockAutoReactivationInputSchema } from '@/modules/renewals/application/use-cases/unblock-auto-reactivation';
import { snoozeAtRiskMemberInputSchema } from '@/modules/renewals/application/use-cases/snooze-at-risk-member';
import { sendReminderNowInputSchema } from '@/modules/renewals/application/use-cases/send-reminder-now';
import { skipEscalationTaskInputSchema } from '@/modules/renewals/application/use-cases/skip-escalation-task';
import { updateSchedulePolicyInputSchema } from '@/modules/renewals/application/use-cases/update-schedule-policy';

const SCHEMAS = [
  ['admin-reactivate-lapsed-cycle', adminReactivateLapsedCycleInputSchema],
  ['escalate-tier-upgrade', escalateTierUpgradeInputSchema],
  ['accept-tier-upgrade', acceptTierUpgradeInputSchema],
  ['block-auto-reactivation', blockAutoReactivationInputSchema],
  ['dismiss-tier-upgrade', dismissTierUpgradeInputSchema],
  ['admin-renew-lapsed-member', adminRenewLapsedMemberInputSchema],
  ['admin-reject-reactivation', adminRejectReactivationInputSchema],
  ['complete-escalation-task', completeEscalationTaskInputSchema],
  ['reassign-escalation-task', reassignEscalationTaskInputSchema],
  ['unblock-auto-reactivation', unblockAutoReactivationInputSchema],
  ['snooze-at-risk-member', snoozeAtRiskMemberInputSchema],
  ['send-reminder-now', sendReminderNowInputSchema],
  ['skip-escalation-task', skipEscalationTaskInputSchema],
  ['update-schedule-policy', updateSchedulePolicyInputSchema],
] as const;

describe('renewals mutation schemas — actorRole accepts the literal staff role (finding #3)', () => {
  it.each(SCHEMAS)('%s: admits admin + super_admin, rejects everything else', (_name, schema) => {
    const actorRole = schema.shape.actorRole;
    expect(actorRole.safeParse('admin').success).toBe(true);
    expect(actorRole.safeParse('super_admin').success).toBe(true);
    for (const rejected of ['manager', 'marketing', 'member', 'system', 'cron', '']) {
      expect(actorRole.safeParse(rejected).success, `${_name} must reject '${rejected}'`).toBe(
        false,
      );
    }
  });
});
