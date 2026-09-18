/**
 * F119 T024 (+ T012's use-case arm) — `setBrandSettings` (FR-041b/c).
 *
 * Refuses a colour whose contrast with white text is below 4.5:1 with the
 * computed ratio and leaves the stored colour in force; audits
 * `broadcast_brand_settings_changed { previous, next, actor_role }` inside
 * the same tx as the write; voids NOTHING (no version, no stage, no
 * `approved_version_id` is touched — the use case has no port for them).
 * 100 % branch pinned (T157).
 */
import { describe, expect, it, vi } from 'vitest';
import { setBrandSettings } from '@/modules/broadcasts/application/use-cases/set-brand-settings';
import type { BrandSettingsRecord, BrandSettingsRepo } from '@/modules/broadcasts/application/ports/brand-settings-repo';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant-swe' as never;
const NOW = new Date('2026-09-18T10:00:00Z');

function makeDeps(current: Partial<BrandSettingsRecord> = {}) {
  const record: BrandSettingsRecord = {
    primaryColor: '#10487a',
    postalAddress: 'Old street 1',
    updatedAt: null,
    updatedByUserId: null,
    ...current,
  };
  const save = vi.fn(async (_t: never, input: { primaryColor: string | null; postalAddress: string | null; updatedByUserId: string }, _tx: unknown) => ({
    ...record,
    primaryColor: input.primaryColor,
    postalAddress: input.postalAddress,
    updatedAt: NOW,
    updatedByUserId: input.updatedByUserId,
  }));
  const repo: BrandSettingsRepo = {
    withTx: vi.fn(async <T,>(_t: never, fn: (tx: unknown) => Promise<T>) => fn('tx-1')),
    find: vi.fn(async () => record),
    save: save as never,
  };
  const audit: AuditPort = { emit: vi.fn(async () => undefined), emitTyped: vi.fn(async () => undefined) };
  return { repo, audit, save };
}

const base = { tenantId: TENANT, actorUserId: 'user-admin-1', actorRole: 'admin' as const, requestId: 'req-1' };

describe('setBrandSettings', () => {
  it('saves a valid colour + address and audits previous → next with the session role, in one tx', async () => {
    const { repo, audit, save } = makeDeps();
    const r = await setBrandSettings({ repo, audit }, { ...base, primaryColor: '#B04A00', postalAddress: 'New street 2\r\nBangkok' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ primaryColor: '#b04a00', postalAddress: 'New street 2\nBangkok' });
    expect(save).toHaveBeenCalledWith(TENANT, { primaryColor: '#b04a00', postalAddress: 'New street 2\nBangkok', updatedByUserId: 'user-admin-1' }, 'tx-1');
    expect(audit.emit).toHaveBeenCalledTimes(1);
    const [tx, event] = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(tx).toBe('tx-1');
    expect(event).toMatchObject({
      eventType: 'broadcast_brand_settings_changed',
      tenantId: TENANT,
      actorUserId: 'user-admin-1',
      requestId: 'req-1',
      payload: {
        previous: { primaryColor: '#10487a', postalAddress: 'Old street 1' },
        next: { primaryColor: '#b04a00', postalAddress: 'New street 2\nBangkok' },
        actor_role: 'admin',
      },
    });
  });

  it('`#f5f5f5` → colour_contrast with the computed ratio and required 4.5; nothing is saved, nothing audited', async () => {
    const { repo, audit, save } = makeDeps();
    const r = await setBrandSettings({ repo, audit }, { ...base, primaryColor: '#f5f5f5', postalAddress: undefined });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe('colour_contrast');
    if (r.error.kind !== 'colour_contrast') return;
    expect(r.error.required).toBe(4.5);
    expect(r.error.ratio).toBeLessThan(1.2);
    expect(save).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
    expect(repo.withTx).not.toHaveBeenCalled();
  });

  it('a malformed colour → invalid_color_format before any tx', async () => {
    const { repo, save } = makeDeps();
    const r = await setBrandSettings({ repo, audit: makeDeps().audit }, { ...base, primaryColor: 'red', postalAddress: undefined });
    expect(r).toEqual({ ok: false, error: { kind: 'invalid_color_format' } });
    expect(save).not.toHaveBeenCalled();
  });

  it('a 301-character address → address_too_long { max: 300 }', async () => {
    const { repo, audit } = makeDeps();
    const r = await setBrandSettings({ repo, audit }, { ...base, primaryColor: undefined, postalAddress: 'x'.repeat(301) });
    expect(r).toEqual({ ok: false, error: { kind: 'address_too_long', max: 300 } });
  });

  it('an omitted field keeps its stored value; an explicit null clears it', async () => {
    const { repo, audit, save } = makeDeps();
    const kept = await setBrandSettings({ repo, audit }, { ...base, primaryColor: undefined, postalAddress: 'Only the address' });
    expect(kept.ok).toBe(true);
    expect(save).toHaveBeenLastCalledWith(TENANT, { primaryColor: '#10487a', postalAddress: 'Only the address', updatedByUserId: 'user-admin-1' }, 'tx-1');
    const cleared = await setBrandSettings({ repo, audit }, { ...base, primaryColor: null, postalAddress: null });
    expect(cleared.ok).toBe(true);
    expect(save).toHaveBeenLastCalledWith(TENANT, { primaryColor: null, postalAddress: null, updatedByUserId: 'user-admin-1' }, 'tx-1');
  });

  it('a no-op save (same values) still returns ok but emits no audit row', async () => {
    const { repo, audit, save } = makeDeps();
    const r = await setBrandSettings({ repo, audit }, { ...base, primaryColor: '#10487a', postalAddress: 'Old street 1' });
    expect(r.ok).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(audit.emit).not.toHaveBeenCalled();
  });

  it('records actor_role as null when the session carries no role — never a literal', async () => {
    const { repo, audit } = makeDeps();
    await setBrandSettings({ repo, audit }, { ...base, actorRole: null, primaryColor: '#b04a00', postalAddress: undefined });
    const [, event] = (audit.emit as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((event as { payload: { actor_role: unknown } }).payload.actor_role).toBeNull();
  });

  it('a repo throw inside the tx surfaces as storage_error (audit row rolled back with it)', async () => {
    const { repo, audit } = makeDeps();
    (repo.save as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const r = await setBrandSettings({ repo, audit }, { ...base, primaryColor: '#b04a00', postalAddress: undefined });
    expect(r).toEqual({ ok: false, error: { kind: 'storage_error', detail: 'boom' } });
  });
});
