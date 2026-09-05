/**
 * 108 FR-003 — the banner's question, as a use case.
 *
 * Three properties, and the third is the one that exists because getting it
 * wrong is invisible: a FAILED READ must not be reported as "this member has no
 * contact". Those are different facts, and collapsing them puts a warning on
 * screen accusing a member's data of a problem that is really a database blip —
 * the same distinction `billing_recipient_read_failed` exists for on the F5
 * side.
 */
import { describe, expect, it, vi } from 'vitest';
import { getMemberMoneyRecipientStatus } from '@/modules/invoicing/application/use-cases/get-member-money-recipient-status';
import { makeRecipientLocaleFake } from '../../helpers/recipient-locale-fake';

const INPUT = { tenantId: 'test-swecham', memberId: 'member-1' } as const;

describe('getMemberMoneyRecipientStatus', () => {
  it('reports deliverable when the member has a live primary contact', async () => {
    const recipientLocale = makeRecipientLocaleFake({
      email: 'live-primary@example.com',
      locale: 'th',
    });

    const r = await getMemberMoneyRecipientStatus({ recipientLocale }, INPUT);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deliverable).toBe(true);
    // `tx === null` — this runs outside any money transaction, so the adapter
    // must self-scope rather than borrow a caller's.
    expect(recipientLocale.getMemberEmailRecipient).toHaveBeenCalledWith(
      null,
      'test-swecham',
      'member-1',
    );
  });

  it('reports NOT deliverable when there is no live primary contact', async () => {
    const recipientLocale = makeRecipientLocaleFake({ email: null });

    const r = await getMemberMoneyRecipientStatus({ recipientLocale }, INPUT);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deliverable).toBe(false);
  });

  it('reports NOT deliverable when the primary address is empty', async () => {
    // Inherited from `resolveMoneyRecipient`, deliberately not re-derived here:
    // the whole point of FR-003 is that the banner and the money path agree on
    // what counts as deliverable. A contact row exists and would satisfy a
    // hand-written `isPrimary && removedAt === null` — the predicate the three
    // pages used to carry inline, which is exactly how the banner stayed silent
    // while every money email was being skipped.
    const recipientLocale = makeRecipientLocaleFake({ email: '   ', locale: 'en' });

    const r = await getMemberMoneyRecipientStatus({ recipientLocale }, INPUT);

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.deliverable).toBe(false);
  });

  it('a THROWN read is read_failed — never "no contact"', async () => {
    const recipientLocale = makeRecipientLocaleFake({ email: null });
    vi.mocked(recipientLocale.getMemberEmailRecipient).mockRejectedValueOnce(
      new Error('connection reset'),
    );

    const r = await getMemberMoneyRecipientStatus({ recipientLocale }, INPUT);

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('read_failed');
  });
});
