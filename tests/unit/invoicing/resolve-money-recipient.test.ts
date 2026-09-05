/**
 * 108 T012 (US1, FR-001/FR-001a/FR-001b/FR-003) — unit coverage for the money-email
 * recipient resolver.
 *
 * The rule this file pins: for a MEMBER invoice the delivery address is read LIVE from
 * the member's primary contact at enqueue time; the frozen `MemberIdentitySnapshot` is
 * consulted ONLY for a non-member (event) buyer, who has no contact row to read. When a
 * member has no live primary contact there is NO fallback — not to the snapshot, not to
 * another contact — the caller must skip the email and audit the skip.
 *
 * Pinned to 100% line + branch in `vitest.config.ts` (money path).
 */
import { describe, expect, it } from 'vitest';
import {
  resolveMoneyRecipient,
  type MoneyRecipient,
} from '@/modules/invoicing/application/lib/resolve-money-recipient';
import { makeRecipientLocaleFake } from '../../helpers/recipient-locale-fake';

function makePort(recipient: { email: string; locale: 'en' | 'th' | 'sv' | null } | null) {
  return makeRecipientLocaleFake(
    recipient === null ? { email: null } : { email: recipient.email, locale: recipient.locale },
  );
}

const SNAPSHOT = { primary_contact_email: 'snapshot-frozen@example.com' } as const;

describe('resolveMoneyRecipient — member invoice', () => {
  it('returns the LIVE primary contact, never the frozen snapshot address', async () => {
    const port = makePort({ email: 'live-primary@example.com', locale: 'th' });

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', 'member-1', SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({
      kind: 'member',
      email: 'live-primary@example.com',
      locale: 'th',
    });
    expect(port.getMemberEmailRecipient).toHaveBeenCalledWith({}, 'test-swecham', 'member-1');
  });

  it('threads the caller tx through to the port (enqueue runs inside the money tx)', async () => {
    const tx = { marker: 'open-tenant-tx' };
    const port = makePort({ email: 'live-primary@example.com', locale: null });

    await resolveMoneyRecipient(port, tx, 'test-swecham', 'member-1', SNAPSHOT);

    expect(port.getMemberEmailRecipient).toHaveBeenCalledWith(tx, 'test-swecham', 'member-1');
  });

  it('carries a null locale through (the outbox applies its own en default)', async () => {
    const port = makePort({ email: 'live-primary@example.com', locale: null });

    const result = await resolveMoneyRecipient(port, null, 'test-swecham', 'member-1', SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({
      kind: 'member',
      email: 'live-primary@example.com',
      locale: null,
    });
  });

  it('keeps an odd-looking or previously-bounced primary address as the ONLY target (FR-001b)', async () => {
    // No redirect, no fallback, no "looks invalid → use the snapshot" branch: deliverability
    // is the dispatcher's problem, recipient CHOICE is this function's problem.
    const port = makePort({ email: 'Odd..Address@Example.COM', locale: 'sv' });

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', 'member-1', SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({
      kind: 'member',
      email: 'Odd..Address@Example.COM',
      locale: 'sv',
    });
  });

  it('returns no_recipient when the member has no live primary contact — never the snapshot', async () => {
    const port = makePort(null);

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', 'member-1', SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({ kind: 'no_recipient' });
  });

  it('returns the TRIMMED address, not the padded one it tested', async () => {
    // Review round 3 finding #4: the emptiness test trimmed and the return did
    // not, so `'  a@b.com  '` reached Stripe's
    // `billing_details.email` and `notifications_outbox.to_email` verbatim — a
    // rejected address surfacing as the opaque `processor_unavailable` this
    // resolver's own comment says it prevents, or a silently dead-lettered
    // outbox row. Whitespace is a data-entry artifact, never part of an
    // address; FR-001b's "an odd address is still THE address" is about the
    // address, not about padding around it.
    const port = makePort({ email: '  padded@example.com  ', locale: 'en' });

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', 'member-1', SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({
      kind: 'member',
      email: 'padded@example.com',
      locale: 'en',
    });
  });

  it('returns no_recipient when the live primary carries an empty address', async () => {
    const port = makePort({ email: '   ', locale: 'en' });

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', 'member-1', SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({ kind: 'no_recipient' });
  });
});

describe('resolveMoneyRecipient — non-member (event) buyer', () => {
  it('uses the frozen snapshot address and never touches the contacts read', async () => {
    const port = makePort({ email: 'never-read@example.com', locale: 'th' });

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', null, SNAPSHOT);

    expect(result).toEqual<MoneyRecipient>({
      kind: 'non_member',
      email: 'snapshot-frozen@example.com',
    });
    expect(port.getMemberEmailRecipient).not.toHaveBeenCalled();
  });

  it('trims the non-member snapshot address too', async () => {
    const port = makePort(null);

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', null, {
      primary_contact_email: ' typed-with-a-space@example.com ',
    });

    expect(result).toEqual<MoneyRecipient>({
      kind: 'non_member',
      email: 'typed-with-a-space@example.com',
    });
  });

  it('returns no_recipient when the non-member snapshot carries an empty address', async () => {
    const port = makePort(null);

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', null, {
      primary_contact_email: '',
    });

    expect(result).toEqual<MoneyRecipient>({ kind: 'no_recipient' });
  });

  it('returns no_recipient when there is no snapshot at all', async () => {
    const port = makePort(null);

    const result = await resolveMoneyRecipient(port, {}, 'test-swecham', null, null);

    expect(result).toEqual<MoneyRecipient>({ kind: 'no_recipient' });
  });
});
