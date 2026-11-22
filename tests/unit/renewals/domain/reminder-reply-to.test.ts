/**
 * The renewal reminder reply-to's display-name rule, one Domain home for the
 * dispatcher (`resolve-reminder-reply-to`) and the admin writer
 * (`update-renewal-reply-to`), so the form can never save a name the
 * dispatcher would drop.
 */
import { describe, expect, it } from 'vitest';
import {
  REPLY_TO_DISPLAY_NAME_MAX,
  REPLY_TO_EMAIL_MAX,
  checkReplyToDisplayName,
} from '@/modules/renewals/domain/reminder-reply-to';

describe('checkReplyToDisplayName', () => {
  it('limits are 254 for the address and 100 for the name', () => {
    expect(REPLY_TO_EMAIL_MAX).toBe(254);
    expect(REPLY_TO_DISPLAY_NAME_MAX).toBe(100);
  });

  it('ordinary names pass, Thai and Swedish included', () => {
    for (const name of ['SweCham Membership', 'หอการค้าไทย-สวีเดน', 'Medlemskap & förnyelse', "O'Brien", 'TSCC. Membership']) {
      expect(checkReplyToDisplayName(name)).toBeNull();
    }
  });

  it('a control character, a line separator or an RFC 5322 special is unsafe', () => {
    for (const name of ['A\r\nBcc: x@y', 'A\tB', 'A\u0000B', 'A\u007fB', 'A B', 'A B', 'Jane <x@y>', 'A, B', 'A; B', 'A: B', 'a@b', 'A (B)', 'A [B]', 'A\\B', 'A "B"']) {
      expect(checkReplyToDisplayName(name)).toBe('unsafe_character');
    }
  });

  it('over 100 characters is too long; exactly 100 passes', () => {
    expect(checkReplyToDisplayName('x'.repeat(101))).toBe('too_long');
    expect(checkReplyToDisplayName('x'.repeat(100))).toBeNull();
  });
});
