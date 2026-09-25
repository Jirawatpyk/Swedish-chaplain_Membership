/**
 * F119 PR-A R1 — the staff detail page's "held" note reads the SAME decision
 * the dispatch legs act on (`decideDispatchStanding`), so the note can never
 * say "held" while the cron refuses, or the reverse.
 *
 * Held = an `approved` E-Blast whose `scheduled_for` has passed and whose
 * member's membership is `suspended` (awaiting payment). Anything else is not
 * held; a read that fails is an error for the page to log, never "held".
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { readDispatchHold } from '@/modules/broadcasts/application/use-cases/read-dispatch-hold';
import { makeFakeSendStanding, type FakeSendStandingOpts } from '../../../helpers/eblast-approval-fakes';

const tenant = asTenantContext('test-tenant');
const NOW = new Date('2026-09-25T05:00:00Z');
const PAST = new Date(NOW.getTime() - 60_000);
const FUTURE = new Date(NOW.getTime() + 60_000);

function run(standing: FakeSendStandingOpts, over: { status?: string; scheduledFor?: Date | null } = {}) {
  const sendStanding = makeFakeSendStanding(standing);
  const result = readDispatchHold(
    { tenant, sendStanding, clock: { now: () => NOW } },
    {
      status: (over.status ?? 'approved') as never,
      scheduledFor: over.scheduledFor === undefined ? PAST : over.scheduledFor,
      memberId: 'm-1',
    },
  );
  return { sendStanding, result };
}

describe('readDispatchHold — is this due E-Blast held for the member’s payment?', () => {
  it('approved, due, member suspended → held', async () => {
    const { result, sendStanding } = run({ access: 'suspended' });
    expect(await result).toEqual({ ok: true, value: true });
    expect(sendStanding.membershipAccess.getMembershipAccess).toHaveBeenCalledWith(tenant, 'm-1');
  });

  it.each([
    ['in good standing', { access: 'full' }],
    ['terminated (the cron refuses it instead)', { access: 'terminated' }],
    ['halted (the cron refuses it instead)', { halted: ['m-1'] }],
  ] as const)('approved, due, member %s → not held', async (_label, standing) => {
    expect(await run(standing).result).toEqual({ ok: true, value: false });
  });

  it.each([
    ['not yet due', { scheduledFor: FUTURE }],
    ['no send time', { scheduledFor: null }],
    ['not approved', { status: 'sent' }],
  ] as const)('%s → not held, and no standing read is made', async (_label, over) => {
    const { result, sendStanding } = run({ access: 'suspended' }, over);
    expect(await result).toEqual({ ok: true, value: false });
    expect(sendStanding.membersBridge.getMembersHaltedInTenant).not.toHaveBeenCalled();
    expect(sendStanding.membershipAccess.getMembershipAccess).not.toHaveBeenCalled();
  });

  it('a read that fails → server_error with its class, never "held"', async () => {
    expect(await run({ access: 'lookup_error' }).result).toEqual({
      ok: false,
      error: { kind: 'server_error', errClass: 'membership_access.lookup_error' },
    });
  });
});
