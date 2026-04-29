/**
 * T043 — Unit tests for `validate-custom-recipients.ts` Application use-case.
 *
 * FR-015d 3-source resolution: members.primary_contact_email +
 * contacts.email + event_attendees.email stub. Each entry MUST resolve
 * to a known email in the tenant graph; unresolved entries are listed
 * in the error response under `broadcast_custom_recipient_unknown`.
 *
 * Turns GREEN: T065 lands `src/modules/broadcasts/application/use-cases/validate-custom-recipients.ts`.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../../src/modules/broadcasts/application/use-cases/validate-custom-recipients.ts',
);

describe('validate-custom-recipients — RED skeleton (T043 — turns GREEN at T065)', () => {
  it('use-case module exists at application/use-cases/validate-custom-recipients.ts', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // FR-015d 3-source resolution branches
  it.todo('resolves email matching member.primary_contact_email (branch 1)');
  it.todo('resolves email matching contact.email (branch 2 — secondary contacts)');
  it.todo('resolves email matching event_attendees.email (branch 3 — F6 stub returns [] in MVP)');
  it.todo('rejects email matching none of 3 branches with broadcast_custom_recipient_unknown');

  // RFC-5321 format validation
  it.todo('rejects malformed email format (no @, missing TLD, etc.)');
  it.todo('rejects email > 254 chars (length cap)');

  // Lowercase + trim normalisation
  it.todo('normalises  "  Alice@Example.COM  " to "alice@example.com" before resolution');
  it.todo('matches case-insensitive against tenant graph');

  // Cap enforcement (FR-016a — 100-entry custom recipient cap)
  it.todo('rejects custom list with > 100 entries with broadcast_audience_too_large');
  it.todo('accepts exactly 100-entry custom list');
  it.todo('accepts 1-entry custom list');

  // Empty / edge cases
  it.todo('rejects empty list with broadcast_empty_segment_blocked');
  it.todo('rejects whitespace-only entries (count as empty after trim)');
  it.todo('deduplicates case-insensitive duplicates before resolution');

  // Error response shape
  it.todo('returns array of unresolved emails on partial-mismatch (not just first)');
  it.todo('returns ok with all-resolved recipient projections on full match');
});
