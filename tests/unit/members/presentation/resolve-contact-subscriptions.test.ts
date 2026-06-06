/**
 * S1 (056 reliability follow-up) — contact-subscription resolver unit spec.
 *
 * Proves the discriminated result that drives the member-detail page's
 * tri-state `SubscriptionBadge`:
 *   - successful lookup → `{ degraded: false, unsubscribed }` and the page
 *     would render Subscribed / Unsubscribed per `unsubscribed.has(id)`.
 *   - the marketing-suppression read THROWS → `{ degraded: true }` so EVERY
 *     contact renders the neutral "Status unavailable" badge instead of
 *     silently defaulting to "Subscribed" (the bug this S1 fix closes).
 *
 * Also locks in the recent log-hygiene polish: the `contact_email_lower_parse_failed`
 * debug breadcrumb on an unparseable email, and the `errKind`-only warn on
 * the degraded path (class name only, never the error message).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  resolveContactSubscriptions,
  type ResolvableContact,
} from '@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-subscriptions';
import { asEmailLower, type EmailLower } from '@/modules/broadcasts';

function lower(raw: string): EmailLower {
  const parsed = asEmailLower(raw.toLowerCase());
  if (!parsed.ok) throw new Error(`bad test email: ${raw}`);
  return parsed.value;
}

const contact = (
  contactId: string,
  email: string | null,
  removedAt: Date | null = null,
): ResolvableContact => ({ contactId, email, removedAt });

function makeLogger() {
  return { debug: vi.fn(), warn: vi.fn() };
}

const errKind = (e: unknown): string =>
  e instanceof Error ? e.constructor.name : 'Unknown';

describe('resolveContactSubscriptions (S1)', () => {
  it('returns degraded:false with the unsubscribed set on a successful read', async () => {
    const logger = makeLogger();
    const lookupBatch = vi
      .fn()
      .mockResolvedValue(new Set<EmailLower>([lower('unsub@example.test')]));

    const result = await resolveContactSubscriptions({
      contacts: [
        contact('c1', 'unsub@example.test'),
        contact('c2', 'clean@example.test'),
      ],
      memberId: 'm1',
      lookupBatch,
      logger,
      errKind,
    });

    expect(result.degraded).toBe(false);
    if (result.degraded) throw new Error('unreachable');
    // c1 unsubscribed → subscribed=false; c2 clean → subscribed=true.
    expect(result.unsubscribed.has('c1')).toBe(true);
    expect(result.unsubscribed.has('c2')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('returns degraded:true when the suppression lookup THROWS (no false "Subscribed")', async () => {
    const logger = makeLogger();
    const lookupBatch = vi
      .fn()
      .mockRejectedValue(new TypeError('Neon connection reset'));

    const result = await resolveContactSubscriptions({
      contacts: [contact('c1', 'a@example.test')],
      memberId: 'm1',
      lookupBatch,
      logger,
      errKind,
    });

    // The page maps degraded → 'unknown' for EVERY contact (the S1 fix).
    expect(result).toEqual({ degraded: true });
    // Log hygiene: errKind is the class name only, never the message.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [logObj] = logger.warn.mock.calls[0]!;
    expect(logObj).toMatchObject({
      event: 'marketing_unsubscribe_lookup_threw',
      errKind: 'TypeError',
      memberId: 'm1',
    });
    expect(JSON.stringify(logObj)).not.toContain('Neon connection reset');
  });

  it('treats no live emails as degraded:false with an empty set (not an outage)', async () => {
    const logger = makeLogger();
    const lookupBatch = vi.fn();

    const result = await resolveContactSubscriptions({
      contacts: [
        contact('c1', null), // no email
        contact('c2', 'x@example.test', new Date()), // removed
      ],
      memberId: 'm1',
      lookupBatch,
      logger,
      errKind,
    });

    expect(result).toEqual({ degraded: false, unsubscribed: new Set() });
    expect(lookupBatch).not.toHaveBeenCalled();
  });

  it('skips an unparseable email with the contact_email_lower_parse_failed breadcrumb', async () => {
    const logger = makeLogger();
    const lookupBatch = vi.fn().mockResolvedValue(new Set<EmailLower>());

    const result = await resolveContactSubscriptions({
      contacts: [contact('c-bad', 'not-an-email')],
      memberId: 'm1',
      lookupBatch,
      logger,
      errKind,
    });

    expect(result.degraded).toBe(false);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'contact_email_lower_parse_failed',
        contactId: 'c-bad',
        memberId: 'm1',
      }),
      expect.any(String),
    );
    // The unparseable contact was skipped, so lookupBatch got an empty list.
    expect(lookupBatch).toHaveBeenCalledWith([]);
  });
});
