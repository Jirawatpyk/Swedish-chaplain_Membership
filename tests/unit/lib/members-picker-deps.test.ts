/**
 * #89 — the composition wrappers over the two slim member reads. Both run
 * under `runInTenant`; a failed read degrades to an empty answer with a warn
 * (the picker then has no preload, the list shows "—"), never a thrown page.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const runInTenant = vi.hoisted(() => vi.fn());
vi.mock('@/lib/db', () => ({ runInTenant }));
const warn = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn, error: vi.fn(), info: vi.fn() } }));

const { runListMemberNamesByIds, runListMemberPickerOptions } = await import('@/lib/members-picker-deps');

describe('members picker deps', () => {
  beforeEach(() => {
    runInTenant.mockReset();
    warn.mockReset();
  });

  it('names: no ids opens no tenant tx', async () => {
    expect((await runListMemberNamesByIds('swecham', [])).size).toBe(0);
    expect(runInTenant).not.toHaveBeenCalled();
  });

  it('names: passes the read result through', async () => {
    const names = new Map([['m-1', 'Acme']]);
    runInTenant.mockResolvedValueOnce(names);
    expect(await runListMemberNamesByIds('swecham', ['m-1'])).toBe(names);
  });

  it('names: a failed read is an empty map and a warn', async () => {
    runInTenant.mockRejectedValueOnce(new TypeError('boom'));
    expect((await runListMemberNamesByIds('swecham', ['m-1'])).size).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'members_picker_names_read_failed', err: 'TypeError' }),
      expect.any(String),
    );
  });

  it('options: passes the read result through, and a failure is an empty list and a warn', async () => {
    const rows = [{ memberId: 'm-1', companyName: 'Acme', planId: 'p', planYear: 2026 }];
    runInTenant.mockResolvedValueOnce(rows);
    expect(await runListMemberPickerOptions('swecham', { statuses: ['active'], limit: 100 })).toBe(rows);
    runInTenant.mockRejectedValueOnce(new TypeError('boom'));
    expect(await runListMemberPickerOptions('swecham', { statuses: ['active'], limit: 100 })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'members_picker_options_read_failed' }),
      expect.any(String),
    );
  });
});
