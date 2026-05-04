/**
 * F8 Phase 4 Wave I2a · T092 spec — `pauseRemindersAfterOutreach`
 * use-case.
 *
 * Read-only — no audit emit, no state mutation. Test scope:
 *   - Input validation (zod boundary)
 *   - Pause TRUE/FALSE branches
 *   - Custom withinDays override
 *   - expiresAt math (latestAt + windowDays)
 */
import { describe, expect, it, vi } from 'vitest';
import {
  pauseRemindersAfterOutreach,
  REMINDER_PAUSE_WINDOW_DAYS,
} from '@/modules/renewals/application/use-cases/pause-reminders-after-outreach';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

const TENANT_ID = 'tenantA';
const MEMBER_ID = '00000000-0000-0000-0000-0000000000aa';

function fakeDeps(
  hasOutreach: boolean,
  latestAt: string | null = null,
): RenewalsDeps {
  return {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    atRiskOutreachReadRepo: {
      hasOutreachWithinDays: vi.fn(async () => ({
        hasOutreach,
        latestAt,
      })),
    } as unknown as RenewalsDeps['atRiskOutreachReadRepo'],
  } as unknown as RenewalsDeps;
}

describe('pauseRemindersAfterOutreach', () => {
  it('returns paused=false when no outreach within 7-day window', async () => {
    const result = await pauseRemindersAfterOutreach(fakeDeps(false), {
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.paused).toBe(false);
  });

  it('returns paused=true with expiresAt = latestOutreachAt + 7d', async () => {
    const latestAt = '2026-05-01T12:00:00.000Z';
    const result = await pauseRemindersAfterOutreach(
      fakeDeps(true, latestAt),
      {
        tenantId: TENANT_ID,
        memberId: MEMBER_ID,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.paused).toBe(true);
    if (!result.value.paused) return;
    expect(result.value.latestOutreachAt).toBe(latestAt);
    expect(result.value.windowDays).toBe(REMINDER_PAUSE_WINDOW_DAYS);
    expect(result.value.expiresAt).toBe('2026-05-08T12:00:00.000Z');
  });

  it('uses default 7-day window when withinDays is omitted', async () => {
    const deps = fakeDeps(false);
    await pauseRemindersAfterOutreach(deps, {
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
    });
    const spy = deps.atRiskOutreachReadRepo
      .hasOutreachWithinDays as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledWith(TENANT_ID, MEMBER_ID, 7);
  });

  it('honours custom withinDays override (e.g. 14-day window)', async () => {
    const deps = fakeDeps(false);
    await pauseRemindersAfterOutreach(deps, {
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      withinDays: 14,
    });
    const spy = deps.atRiskOutreachReadRepo
      .hasOutreachWithinDays as ReturnType<typeof vi.fn>;
    expect(spy).toHaveBeenCalledWith(TENANT_ID, MEMBER_ID, 14);
  });

  it('expiresAt math respects custom windowDays', async () => {
    const latestAt = '2026-05-01T00:00:00.000Z';
    const result = await pauseRemindersAfterOutreach(
      fakeDeps(true, latestAt),
      {
        tenantId: TENANT_ID,
        memberId: MEMBER_ID,
        withinDays: 14,
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || !result.value.paused) return;
    expect(result.value.expiresAt).toBe('2026-05-15T00:00:00.000Z');
    expect(result.value.windowDays).toBe(14);
  });

  it('handles defensive case: hasOutreach=true but latestAt=null → paused=false', async () => {
    // Defensive — adapter contract says latestAt non-null when
    // hasOutreach=true, but the use-case treats null defensively.
    const result = await pauseRemindersAfterOutreach(fakeDeps(true, null), {
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.paused).toBe(false);
  });

  it('rejects invalid memberId (not UUID) with invalid_input', async () => {
    const result = await pauseRemindersAfterOutreach(fakeDeps(false), {
      tenantId: TENANT_ID,
      memberId: 'not-a-uuid',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects empty tenantId with invalid_input', async () => {
    const result = await pauseRemindersAfterOutreach(fakeDeps(false), {
      tenantId: '',
      memberId: MEMBER_ID,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects withinDays out of [1, 365] range with invalid_input', async () => {
    const tooLow = await pauseRemindersAfterOutreach(fakeDeps(false), {
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      withinDays: 0,
    });
    expect(tooLow.ok).toBe(false);
    const tooHigh = await pauseRemindersAfterOutreach(fakeDeps(false), {
      tenantId: TENANT_ID,
      memberId: MEMBER_ID,
      withinDays: 366,
    });
    expect(tooHigh.ok).toBe(false);
  });

  it('REMINDER_PAUSE_WINDOW_DAYS canonical constant equals 7 (FR-033)', () => {
    expect(REMINDER_PAUSE_WINDOW_DAYS).toBe(7);
  });
});
