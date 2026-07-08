/**
 * `exportMembersBackup` use-case unit tests (design 2026-07-07).
 * Pins: admin-only gate (manager AND member → forbidden, no source touch),
 * ZIP receives exactly 3 named CSV files, audit recordInTx commits inside
 * the same tx with per-file counts, Bangkok-local filename stamp, and the
 * throw path (source throws → 'gather_failed', no audit emit).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db', () => ({
  runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => Promise<unknown>) =>
    fn({ __fakeTx: true }),
  ),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { exportMembersBackup } from '@/modules/insights/application/use-cases/export-members-backup';
import type { MembersBackupData } from '@/modules/insights/application/ports/members-backup-source';
import type { TenantContext } from '@/modules/tenants';

const ctx = { slug: 'test-swecham' } as unknown as TenantContext;

const data: MembersBackupData = {
  members: [
    {
      memberNumber: 'SCCM-0001', companyName: 'ABC Co.', legalEntityType: null,
      taxId: null, isHeadOffice: true, website: null, foundedYear: null,
      plan: 'Gold', planYear: 2026, registrationFeePaid: true, status: 'active',
      addressLine1: null, addressLine2: null, city: null, province: null,
      postalCode: null, country: 'TH', preferredLocale: null,
      lastActivityAt: null, riskBand: null, notes: null,
      createdAt: '2026-01-01T00:00:00Z', archivedAt: null, erasedAt: null,
    },
  ],
  contacts: [
    {
      memberNumber: 'SCCM-0001', firstName: 'Anna', lastName: 'S',
      email: 'a@x.example', phone: null, roleTitle: null,
      preferredLanguage: null, isPrimary: true, dateOfBirth: null,
      createdAt: null,
    },
  ],
  invoices: [],
};

function makeDeps() {
  return {
    source: { gatherInTx: vi.fn().mockResolvedValue(data) },
    audit: { recordInTx: vi.fn().mockResolvedValue(undefined), record: vi.fn() },
    zip: vi.fn().mockReturnValue(new Uint8Array([80, 75])),
    clock: { now: () => new Date('2026-07-07T10:30:00Z') }, // BKK 17:30
  };
}

const meta = {
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  requestId: 'req-1',
};

describe('exportMembersBackup', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(['manager', 'member'] as const)('%s → forbidden, source never touched', async (role) => {
    const deps = makeDeps();
    const res = await exportMembersBackup({ ...meta, actorRole: role }, ctx, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('forbidden');
    expect(deps.source.gatherInTx).not.toHaveBeenCalled();
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
  });

  it('admin: zips 3 named CSVs, audits counts in-tx, Bangkok filename', async () => {
    const deps = makeDeps();
    const res = await exportMembersBackup(meta, ctx, deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(deps.zip).toHaveBeenCalledTimes(1);
    const files = deps.zip.mock.calls[0]![0] as ReadonlyArray<{ name: string; content: string }>;
    expect(files.map((f) => f.name)).toEqual(['members.csv', 'contacts.csv', 'invoices.csv']);
    expect(files[0]!.content.startsWith('﻿')).toBe(true);

    expect(deps.audit.recordInTx).toHaveBeenCalledWith(
      { __fakeTx: true },
      expect.objectContaining({
        eventType: 'members_backup_exported',
        actorUserId: 'admin-1',
        retentionYears: 5,
        payload: { member_count: 1, contact_count: 1, invoice_count: 0 },
      }),
    );

    // 2026-07-07T10:30Z = 17:30 Bangkok
    expect(res.value.filename).toBe('test-swecham-members-backup-20260707-1730.zip');
    expect(res.value.rowCounts).toEqual({ members: 1, contacts: 1, invoices: 0 });
  });

  it('source throws → gather_failed, no audit emit', async () => {
    const deps = makeDeps();
    deps.source.gatherInTx.mockRejectedValueOnce(new Error('neon transient'));
    const res = await exportMembersBackup(meta, ctx, deps);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('gather_failed');
    expect(deps.audit.recordInTx).not.toHaveBeenCalled();
    expect(deps.zip).not.toHaveBeenCalled();
  });
});
