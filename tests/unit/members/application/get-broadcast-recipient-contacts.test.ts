/**
 * Unit tests for `getBroadcastRecipientContacts` (108 PR-C, T071 / T074).
 *
 * Pure pass-through to `memberRepo.findBroadcastRecipientContacts` — the
 * eligibility rules (data-model § 1: member `status = 'active'`, not erased,
 * not halted; contact live and not opted out; LEFT JOIN so an orphan member
 * surfaces as one row with a null contact) live in the SQL and are proved on
 * live Neon by
 * `tests/integration/members/broadcast-recipient-contacts-keyset.test.ts`.
 *
 * Pinned here: every input is forwarded verbatim (segment, tier codes, the
 * keyset cursor, the page size) and the repo Result comes back UNCHANGED —
 * including the error leg. The F7 bridge must see `repo.unexpected` so it can
 * propagate a page failure instead of answering `[]` (research R8: a silent
 * `[]` under pagination is a second truncation vector).
 */
import { describe, expect, it, vi } from 'vitest';
import { err, ok } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import { getBroadcastRecipientContacts } from '@/modules/members/application/use-cases/get-broadcast-recipient-contacts';
import type { F7ContactRecipient } from '@/modules/members/application/ports/member-repo';

const tenant = asTenantContext('test-tenant');

function row(memberId: string, contactId: string | null): F7ContactRecipient {
  return {
    memberId: memberId as F7ContactRecipient['memberId'],
    contactId,
    emailLower: contactId === null ? null : `${contactId}@example.com`,
    isPrimary: contactId !== null,
  };
}

type Deps = Parameters<typeof getBroadcastRecipientContacts>[0];

describe('getBroadcastRecipientContacts (108 PR-C)', () => {
  it('forwards all_members + first page (no cursor) and returns the repo rows unchanged', async () => {
    const rows = [row('m1', 'c1'), row('m1', 'c2'), row('m2', null)];
    const memberRepo = {
      findBroadcastRecipientContacts: vi.fn().mockResolvedValue(ok(rows)),
    } as unknown as Deps['memberRepo'];

    const result = await getBroadcastRecipientContacts(
      { tenant, memberRepo },
      { segmentType: 'all_members', after: null, limit: 1000 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(rows);
    expect(memberRepo.findBroadcastRecipientContacts).toHaveBeenCalledWith(tenant, {
      segmentType: 'all_members',
      after: null,
      limit: 1000,
    });
  });

  it('forwards tier codes AND the keyset cursor verbatim — including a null contact id after an orphan row', async () => {
    const memberRepo = {
      findBroadcastRecipientContacts: vi.fn().mockResolvedValue(ok([])),
    } as unknown as Deps['memberRepo'];

    await getBroadcastRecipientContacts(
      { tenant, memberRepo },
      {
        segmentType: 'tier',
        tierCodes: ['corporate', 'partnership'],
        after: { memberId: 'm-orphan', contactId: null },
        limit: 1000,
      },
    );

    expect(memberRepo.findBroadcastRecipientContacts).toHaveBeenCalledWith(tenant, {
      segmentType: 'tier',
      tierCodes: ['corporate', 'partnership'],
      after: { memberId: 'm-orphan', contactId: null },
      limit: 1000,
    });
  });

  it('returns the repo error unchanged — a page failure is the caller\'s to propagate, never an empty page', async () => {
    const failure = err({ code: 'repo.unexpected' as const, cause: new Error('neon down') });
    const memberRepo = {
      findBroadcastRecipientContacts: vi.fn().mockResolvedValue(failure),
    } as unknown as Deps['memberRepo'];

    const result = await getBroadcastRecipientContacts(
      { tenant, memberRepo },
      { segmentType: 'all_members', after: null, limit: 1000 },
    );

    expect(result).toBe(failure);
  });
});
