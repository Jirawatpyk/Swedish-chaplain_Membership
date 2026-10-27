/**
 * Spec 122 PR C (R95) — the raw `tx.execute` read of
 * `members.broadcasts_acknowledged_at` comes back as a STRING: Drizzle's
 * postgres-js driver turns off the timestamptz parser (OID 1184). The compose
 * page called `.toISOString()` on it and crashed for every acknowledged
 * company. The read hands back a Date (or null) whatever the driver returns.
 */
import { describe, expect, it, vi } from 'vitest';

const rows = vi.hoisted(() => ({ value: [] as Array<{ broadcasts_acknowledged_at: unknown }> }));
vi.mock('@/lib/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/db')>()),
  runInTenant: async (_ctx: unknown, fn: (tx: unknown) => unknown) =>
    fn({ execute: async () => rows.value }),
}));

const { readBroadcastsAcknowledgedAt } = await import(
  '@/app/(member)/portal/_components/broadcasts-acknowledgement'
);

const tenant = { slug: 'swecham' } as never;

describe('readBroadcastsAcknowledgedAt — the value it hands back', () => {
  it('turns the driver string into a Date', async () => {
    rows.value = [{ broadcasts_acknowledged_at: '2026-10-27 09:21:00.898+00' }];
    const at = await readBroadcastsAcknowledgedAt(tenant, 'member-string');
    expect(at).toBeInstanceOf(Date);
    expect(at?.toISOString()).toBe('2026-10-27T09:21:00.898Z');
  });

  it('keeps a Date a Date', async () => {
    rows.value = [{ broadcasts_acknowledged_at: new Date('2026-10-01T03:00:00.000Z') }];
    const at = await readBroadcastsAcknowledgedAt(tenant, 'member-date');
    expect(at?.toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it.each([
    ['a NULL column', [{ broadcasts_acknowledged_at: null }]],
    ['no row', []],
  ])('%s reads as null', async (_label, value) => {
    rows.value = value;
    expect(await readBroadcastsAcknowledgedAt(tenant, `member-${_label}`)).toBeNull();
  });
});
