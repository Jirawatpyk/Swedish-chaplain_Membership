/**
 * T044 — Unit tests for `resolve-segment-recipients.ts` Application use-case.
 *
 * Resolves all 4 segment types (FR-015) → recipient list with suppression
 * filter applied + member-self-exclusion (Q16 + FR-015c) + 5k cap (FR-016a) +
 * `member_missing_primary_contact` audit emit per missed member.
 *
 * Turns GREEN: T066 lands `src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts`.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/resolve-segment-recipients.ts',
);

describe('resolve-segment-recipients — RED skeleton (T044 — turns GREEN at T066)', () => {
  it('use-case module exists at application/use-cases/resolve-segment-recipients.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // 4 segment-type branches (FR-015)
  it.todo('all_members: returns every active member with primary contact email');
  it.todo('tier:premium: returns only members on plan tier "premium"');
  it.todo('tier with multiple codes: union of members across tiers');
  it.todo('event_attendees_last_90d: F7 stub returns [] (FR-015a — F6 swap-in deferred)');
  it.todo('custom: returns recipients from validated custom-list (delegates to validate-custom-recipients)');

  // Suppression filter (FR-027 cascade — recipients in marketing_unsubscribes excluded)
  it.todo('excludes recipients with active suppression record');
  it.todo('preserves recipients with NO suppression record');
  it.todo('suppression filter applied PER tenant (cross-tenant invariant Q8)');

  // Self-exclusion (Q16 + FR-015c)
  it.todo('excludes the broadcasting member themselves from recipient list');
  it.todo('Q16: member-self exclusion applies even on tier:<own-tier> segment');

  // Recipient cap (FR-016a — 5,000 recipients per broadcast)
  it.todo('accepts exactly 5,000 recipients (boundary)');
  it.todo('rejects > 5,000 recipients with broadcast_audience_too_large');

  // Member-missing-primary-contact handling (FR-015c)
  it.todo('emits member_missing_primary_contact audit per filtered-out member');
  it.todo('rolls up missing-contact count in resolver result for caller observability');

  // Halted-member exclusion (Q14 — broadcasts_halted_until_admin_review = true)
  it.todo('excludes halted members from segment resolution (defence-in-depth with member-side blocking)');

  // Empty results
  it.todo('returns empty list when segment matches no eligible members → caller emits broadcast_empty_segment_blocked');
});
