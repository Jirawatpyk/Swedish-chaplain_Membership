/**
 * #739 B3b — the invitation outbox insert's failure carries the thrown
 * value's class, never its message: a drizzle error's message quotes the
 * bound `to_email`, and create-user / reissue-invitation log this field.
 */
import { describe, expect, it } from 'vitest';
import { defaultCreateUserDeps } from '@/lib/auth-deps';

class DrizzleQueryError extends Error {}

describe('enqueueInvitationInTx — a failed insert (#739 B3b)', () => {
  it('returns enqueue_failed with the class and no message text', async () => {
    const tx = {
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new DrizzleQueryError('Failed query: insert … params: invitee@b.example');
          },
        }),
      }),
    };
    const result = await defaultCreateUserDeps.enqueueInvitationInTx(tx as never, {
      tenantId: 't1',
      toEmail: 'Invitee@b.example',
      token: 'tok' as never,
      role: 'member',
    } as never);
    expect(result).toEqual({ ok: false, error: { code: 'enqueue_failed', errClass: 'DrizzleQueryError' } });
    expect(JSON.stringify(result)).not.toContain('b.example');
  });

  it('#739 B3b part 2: carries the SQLSTATE under the driver error, so a unique violation reads apart from an outage', async () => {
    const pg = Object.assign(new Error('duplicate key … invitee@b.example'), { code: '23505' });
    const tx = {
      insert: () => ({
        values: () => ({
          returning: async () => {
            throw new DrizzleQueryError('Failed query: insert … params: invitee@b.example', { cause: pg });
          },
        }),
      }),
    };
    const result = await defaultCreateUserDeps.enqueueInvitationInTx(tx as never, {
      tenantId: 't1',
      toEmail: 'invitee@b.example',
      token: 'tok' as never,
      role: 'member',
    } as never);
    expect(result).toEqual({
      ok: false,
      error: { code: 'enqueue_failed', errClass: 'DrizzleQueryError', sqlState: '23505' },
    });
    expect(JSON.stringify(result)).not.toContain('b.example');
  });
});
