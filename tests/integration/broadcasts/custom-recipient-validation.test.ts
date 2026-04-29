/**
 * T048 — Integration test for FR-015d custom-recipient validation.
 *
 * Seed live Neon with: 3 members (primary contacts) + 5 contacts +
 * 0 event attendees (F6 stub returns []). Submit a broadcast with a
 * custom list mixing all 3 resolution branches + unknown emails →
 * verify each branch hits the right resolver, unresolved entries are
 * listed in the 422 error response.
 *
 * Turns GREEN: T065 (validate-custom-recipients.ts) + T076 (submit route)
 * + T060 (members-bridge adapter wiring real F3 lookups) all land.
 */
import { describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';

const useCasePath = resolve(
  __dirname,
  '../../../src/modules/broadcasts/application/use-cases/validate-custom-recipients.ts',
);

describe('custom-recipient-validation integration — RED skeleton (T048 — turns GREEN at T065 + T076 + T060)', () => {
  it('validate-custom-recipients use-case exists', async () => {
    await expect(access(useCasePath)).resolves.toBeUndefined();
  });

  // FR-015d 3-source resolution branches (live DB seed required)
  it.todo('branch 1: email matches member.primary_contact_email → resolved');
  it.todo('branch 2: email matches contact.email (secondary contact) → resolved');
  it.todo('branch 3: email matches event_attendees.email — F6 stub returns [] → fallthrough');
  it.todo('all 3 branches miss → 422 broadcast_custom_recipient_unknown lists each unresolved');

  // Mixed list (most realistic case)
  it.todo('partial mismatch: 5 valid + 2 invalid → 422 lists ONLY the 2 invalid emails');
  it.todo('all match: 5 valid emails → resolves to 5-recipient list');

  // Cross-tenant isolation (Q8 + FR-015c)
  it.todo('cross-tenant: email from tenant-B → 422 unknown (not visible to tenant-A)');

  // Normalisation
  it.todo('case-insensitive match: "ALICE@Example.com" matches stored "alice@example.com"');

  // Cap (FR-016a — 100 entries)
  it.todo('100 valid entries → all resolved');
  it.todo('101 entries → 422 broadcast_audience_too_large (exceeds cap)');

  // Cleanup
  it.todo('afterAll deletes all seed members + contacts + suppression rows');
});
