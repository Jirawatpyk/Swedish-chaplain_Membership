/**
 * #707 — the tenant's renewal reply-to (`tenant_renewal_settings`) becomes the
 * reminder's Reply-To, snapshotted on the reminder row at its first attempt.
 * A value Resend would refuse (a malformed address, a header-breaking name)
 * never reaches a send: it resolves to "no reply-to" and is logged by kind.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { logger } from '@/lib/logger';
import { resolveReminderReplyTo } from '@/modules/renewals/application/use-cases/_lib/resolve-reminder-reply-to';

const TENANT = 'tenanta';

describe('resolveReminderReplyTo (#707)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('a valid address and name come through, trimmed', () => {
    expect(
      resolveReminderReplyTo(
        { replyToEmail: ' renewals@swecham.example ', replyToDisplayName: ' SweCham Membership ' },
        TENANT,
      ),
    ).toEqual({ email: 'renewals@swecham.example', displayName: 'SweCham Membership' });
  });

  it('an address without a name keeps the address; an empty name is no name', () => {
    expect(resolveReminderReplyTo({ replyToEmail: 'renewals@swecham.example', replyToDisplayName: null }, TENANT)).toEqual({
      email: 'renewals@swecham.example',
      displayName: null,
    });
    expect(resolveReminderReplyTo({ replyToEmail: 'renewals@swecham.example', replyToDisplayName: '  ' }, TENANT)).toEqual({
      email: 'renewals@swecham.example',
      displayName: null,
    });
  });

  it('no settings row, or no address, is no reply-to and logs nothing', () => {
    expect(resolveReminderReplyTo(null, TENANT)).toBeNull();
    expect(resolveReminderReplyTo({ replyToEmail: null, replyToDisplayName: 'SweCham' }, TENANT)).toBeNull();
    expect(resolveReminderReplyTo({ replyToEmail: '   ', replyToDisplayName: null }, TENANT)).toBeNull();
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled();
  });

  it('a malformed address is no reply-to, and the warn names the tenant, never the value', () => {
    expect(resolveReminderReplyTo({ replyToEmail: 'not an address', replyToDisplayName: null }, TENANT)).toBeNull();
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { event: 'renewals.reply_to_invalid', tenantId: TENANT, field: 'email' },
      expect.any(String),
    );
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('not an address');
  });

  it('a name with a line break or over 100 characters is dropped; the address stays', () => {
    const crlf = resolveReminderReplyTo(
      { replyToEmail: 'renewals@swecham.example', replyToDisplayName: 'SweCham\r\nBcc: x@y.example' },
      TENANT,
    );
    expect(crlf).toEqual({ email: 'renewals@swecham.example', displayName: null });
    const long = resolveReminderReplyTo(
      { replyToEmail: 'renewals@swecham.example', replyToDisplayName: 'x'.repeat(101) },
      TENANT,
    );
    expect(long).toEqual({ email: 'renewals@swecham.example', displayName: null });
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      { event: 'renewals.reply_to_invalid', tenantId: TENANT, field: 'display_name' },
      expect.any(String),
    );
  });

  it('review (PDPA L-1): a name with address syntax (< > " , ; ( ) \\) is dropped, so it can never redirect a reply', () => {
    for (const name of ['Jane <x@evil.example>', 'Jane, x@evil.example', 'Jane "Q"', 'A; B', 'A\\B', 'A>B', 'Jane (x@evil.example)']) {
      expect(
        resolveReminderReplyTo({ replyToEmail: 'renewals@swecham.example', replyToDisplayName: name }, TENANT),
      ).toEqual({ email: 'renewals@swecham.example', displayName: null });
    }
    // Ordinary names, Thai and Swedish included, stay.
    for (const name of ['SweCham Membership', 'หอการค้าไทย-สวีเดน', 'Medlemskap & förnyelse', "O'Brien Membership"]) {
      expect(
        resolveReminderReplyTo({ replyToEmail: 'renewals@swecham.example', replyToDisplayName: name }, TENANT),
      ).toEqual({ email: 'renewals@swecham.example', displayName: name });
    }
  });

  it('review (code-review, reliability M-1): a name with : @ [ ] or a control character is dropped too', () => {
    for (const name of ['Membership: TSCC', 'renewals@tscc', 'TSCC [Membership]', 'A\tB', 'A\u0000B', 'A\u007fB', 'A\u2028B']) {
      expect(
        resolveReminderReplyTo({ replyToEmail: 'renewals@swecham.example', replyToDisplayName: name }, TENANT),
      ).toEqual({ email: 'renewals@swecham.example', displayName: null });
    }
  });
});
