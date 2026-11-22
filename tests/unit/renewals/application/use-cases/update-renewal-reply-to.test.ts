/**
 * PR B (#707 follow-up): staff set the renewal reminder Reply-To.
 *
 * `updateRenewalReplyTo` validates with the dispatcher's own rules, writes
 * `tenant_renewal_settings.reply_to_*` and the `renewal_reply_to_updated`
 * audit row in one transaction, and only when something changed. The audit
 * payload keeps the address's domain, never the address (PDPA: a 5-year copy
 * of staff contact data). `loadRenewalReplyTo` reads the current values.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { TenantRenewalSettings } from '@/modules/renewals/domain/tenant-renewal-settings';
import { updateRenewalReplyTo } from '@/modules/renewals/application/use-cases/update-renewal-reply-to';
import { loadRenewalReplyTo } from '@/modules/renewals/application/use-cases/load-renewal-reply-to';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) => fn({ tx: true }),
}));

const TENANT_ID = 'tenantA';

function row(email: string | null, name: string | null): TenantRenewalSettings {
  return {
    tenantId: TENANT_ID,
    gracePeriodDays: 14,
    autoUpgradeEnabled: false,
    minTenureDaysForAtRisk: 90,
    dispatchCronEnabled: true,
    replyToEmail: email,
    replyToDisplayName: name,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function fakeDeps(prior: TenantRenewalSettings | null) {
  const upsert = vi.fn(async (_tx: unknown, _t: string, input: { replyToEmail?: string | null; replyToDisplayName?: string | null }) =>
    row(input.replyToEmail ?? null, input.replyToDisplayName ?? null),
  );
  const findByTenant = vi.fn(async () => prior);
  const emitInTx = vi.fn(async () => {});
  const deps = {
    tenant: { slug: TENANT_ID },
    tenantRenewalSettingsRepo: { findByTenant, upsert },
    auditEmitter: { emit: vi.fn(), emitInTx },
  } as unknown as RenewalsDeps;
  return { deps, upsert, findByTenant, emitInTx };
}

const BASE = {
  tenantId: TENANT_ID,
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
  requestId: 'req-1',
};

describe('updateRenewalReplyTo', () => {
  beforeEach(() => vi.clearAllMocks());

  it('setting an address and name writes both, trimmed, and audits set with the domain only', async () => {
    const { deps, upsert, emitInTx } = fakeDeps(null);
    const r = await updateRenewalReplyTo(deps, {
      ...BASE,
      email: ' membership@SweCham.example ',
      displayName: ' SweCham Membership ',
    });
    expect(r).toEqual({ ok: true, value: { email: 'membership@SweCham.example', displayName: 'SweCham Membership', changed: true } });
    expect(upsert).toHaveBeenCalledWith(expect.anything(), TENANT_ID, {
      replyToEmail: 'membership@SweCham.example',
      replyToDisplayName: 'SweCham Membership',
    });
    expect(emitInTx).toHaveBeenCalledTimes(1);
    const [, event, ctx] = emitInTx.mock.calls[0] as unknown as [unknown, { type: string; payload: unknown }, { actorRole: string; tenantId: string }];
    expect(event).toEqual({
      type: 'renewal_reply_to_updated',
      payload: { change: 'set', email_set: true, email_domain: 'swecham.example', display_name_set: true },
    });
    expect(ctx).toMatchObject({ tenantId: TENANT_ID, actorRole: 'admin', actorUserId: 'admin-1', correlationId: 'corr-1' });
    expect(JSON.stringify(emitInTx.mock.calls)).not.toContain('membership@');
  });

  it('changing the address audits changed', async () => {
    const { deps, emitInTx } = fakeDeps(row('old@swecham.example', null));
    await updateRenewalReplyTo(deps, { ...BASE, email: 'new@tscc.example', displayName: null });
    const event = (emitInTx.mock.calls[0] as unknown as [unknown, { payload: unknown }])[1];
    expect(event.payload).toEqual({ change: 'changed', email_set: true, email_domain: 'tscc.example', display_name_set: false });
  });

  it('an empty address clears both and audits cleared', async () => {
    const { deps, upsert, emitInTx } = fakeDeps(row('old@swecham.example', 'Old'));
    const r = await updateRenewalReplyTo(deps, { ...BASE, email: '  ', displayName: null });
    expect(r).toEqual({ ok: true, value: { email: null, displayName: null, changed: true } });
    expect(upsert).toHaveBeenCalledWith(expect.anything(), TENANT_ID, { replyToEmail: null, replyToDisplayName: null });
    const event = (emitInTx.mock.calls[0] as unknown as [unknown, { payload: unknown }])[1];
    expect(event.payload).toEqual({ change: 'cleared', email_set: false, email_domain: null, display_name_set: false });
  });

  it('saving the same values writes nothing and audits nothing', async () => {
    const { deps, upsert, emitInTx } = fakeDeps(row('membership@swecham.example', 'SweCham'));
    const r = await updateRenewalReplyTo(deps, { ...BASE, email: 'membership@swecham.example', displayName: 'SweCham' });
    expect(r).toEqual({ ok: true, value: { email: 'membership@swecham.example', displayName: 'SweCham', changed: false } });
    expect(upsert).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('clearing when nothing is set writes nothing', async () => {
    const { deps, upsert } = fakeDeps(null);
    const r = await updateRenewalReplyTo(deps, { ...BASE, email: null, displayName: null });
    expect(r.ok && r.value.changed).toBe(false);
    expect(upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['a malformed address', { email: 'not an address', displayName: null }, 'invalid_email'],
    ['an address over 254 characters', { email: `${'a'.repeat(250)}@x.example`, displayName: null }, 'invalid_email'],
    ['a name with address syntax', { email: 'm@swecham.example', displayName: 'Jane <x@evil.example>' }, 'invalid_display_name'],
    ['a name with a line break', { email: 'm@swecham.example', displayName: 'A\r\nBcc: x@y' }, 'invalid_display_name'],
    ['a name over 100 characters', { email: 'm@swecham.example', displayName: 'x'.repeat(101) }, 'invalid_display_name'],
    ['a name without an address', { email: null, displayName: 'SweCham' }, 'display_name_without_email'],
  ])('%s is refused with no write', async (_label, values, kind) => {
    const { deps, upsert, emitInTx } = fakeDeps(null);
    const r = await updateRenewalReplyTo(deps, { ...BASE, ...values });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe(kind);
    expect(upsert).not.toHaveBeenCalled();
    expect(emitInTx).not.toHaveBeenCalled();
  });

  it('a repo failure is server_error with a class, never the text', async () => {
    const { deps, upsert } = fakeDeps(null);
    upsert.mockRejectedValueOnce(new Error('insert failed for membership@swecham.example'));
    const r = await updateRenewalReplyTo(deps, { ...BASE, email: 'membership@swecham.example', displayName: null });
    expect(r).toEqual({ ok: false, error: { kind: 'server_error', message: 'Error' } });
  });
});

describe('loadRenewalReplyTo', () => {
  it('returns the stored values, or nulls when the tenant has no settings row', async () => {
    expect(await loadRenewalReplyTo(fakeDeps(row('m@swecham.example', 'SweCham')).deps, TENANT_ID)).toEqual({
      ok: true,
      value: { email: 'm@swecham.example', displayName: 'SweCham' },
    });
    expect(await loadRenewalReplyTo(fakeDeps(null).deps, TENANT_ID)).toEqual({
      ok: true,
      value: { email: null, displayName: null },
    });
  });

  it('a read failure is server_error', async () => {
    const { deps, findByTenant } = fakeDeps(null);
    findByTenant.mockRejectedValueOnce(new Error('boom'));
    expect(await loadRenewalReplyTo(deps, TENANT_ID)).toEqual({ ok: false, error: { kind: 'server_error', message: 'Error' } });
  });
});
