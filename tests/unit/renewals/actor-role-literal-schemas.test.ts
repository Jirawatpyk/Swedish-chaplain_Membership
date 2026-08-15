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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
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
import { discardAutoDraftedRenewalInputSchema } from '@/modules/renewals/application/use-cases/discard-auto-drafted-renewal';
import { bulkSendRenewalReminderInputSchema } from '@/modules/renewals/application/use-cases/bulk-send-renewal-reminder';
import { issueAutoDraftedRenewalInputSchema } from '@/modules/renewals/application/use-cases/issue-auto-drafted-renewal';

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
  // Financial-review B-1 follow-through — three more staff-actor mutation
  // schemas widened after the body sweep exposed them:
  ['discard-auto-drafted-renewal', discardAutoDraftedRenewalInputSchema],
  ['bulk-send-renewal-reminder', bulkSendRenewalReminderInputSchema],
  ['issue-auto-drafted-renewal', issueAutoDraftedRenewalInputSchema],
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

/**
 * Financial-review B-1 (2026-08-14) — the schema widen alone proved NOTHING:
 * 13 of 14 use-case bodies discarded `input.actorRole` and hardcoded
 * `actorRole: 'admin'` into the append-only audit-emit context, so every
 * emit still lied about the actor while 1,672 tests stayed green. This
 * tripwire reads every renewals use-case SOURCE file and fails on any
 * STAFF-role literal in an actorRole/actor_role position — the only
 * legitimate remaining literals are non-staff actor kinds ('cron',
 * 'system', 'webhook', 'member'). The last two survivors (the cron-REPLAY
 * emits in reconcile-pending-reactivations) died with migration 0290: the
 * decision-time role is now persisted on the marker and replayed, with a
 * fallback expression (`rejectActorRole === 'super_admin' ? … : 'admin'`)
 * that this regex correctly does not match (the literal is not in the
 * value position after `actorRole:`).
 *
 * SCOPE NOTE (017): this file stays RENEWALS-scoped on purpose — it lives
 * next to the schema pins it complements. The codebase-wide successor is
 * `scripts/check-actor-role-truth.ts` (wired into pre-push + CI), written
 * after the same class was found again in invoicing, events and the F7
 * members-bridge. A fix here does not reach those; that gate does.
 */
describe('no use-case body hardcodes a staff actor role (B-1 tripwire)', () => {
  it('every staff-role literal outside the documented replay sites is gone', () => {
    const root = join(
      process.cwd(),
      'src', 'modules', 'renewals', 'application', 'use-cases',
    );
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(30); // the walker actually walked

    // `(?!\s*\|)` skips TYPE-union annotations (`actorRole: 'admin' |
    // 'super_admin'`) — only VALUE positions are stamps.
    const STAFF_LITERAL = /actor_?[Rr]ole:\s*'(admin|manager|super_admin)'(?!\s*\|)/g;
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      STAFF_LITERAL.lastIndex = 0;
      for (const m of src.matchAll(STAFF_LITERAL)) {
        offenders.push(`${file.slice(root.length + 1)}: ${m[0]}`);
      }
    }

    // ZERO survivors since migration 0290 persisted the decision-time role
    // for the cron-replay emits. Any hit is the B-1 class returning.
    expect(offenders).toEqual([]);
  });
});
