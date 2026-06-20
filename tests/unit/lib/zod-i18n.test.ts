/**
 * zod-i18n shared field helpers — every reusable form constraint must
 * carry an i18n message, never Zod's built-in English default
 * ("Invalid email", "String must contain at least 1 character(s)").
 *
 * Regression guard for the 2026-06-20 raw-Zod-leak sweep: a sentinel
 * translator echoes the key (+ params) so a leaked Zod default is
 * impossible to mistake for a localized message.
 */
import { describe, it, expect } from 'vitest';
import {
  requiredText,
  emailText,
  boundedText,
  passwordPairFields,
  type Translator,
} from '@/lib/zod-i18n';

// Echoes the i18n key (+ ICU params) so a raw Zod default would stand
// out immediately — any English Zod string here is a failed assertion.
const tv: Translator = (key, values) =>
  values ? `${key}:${JSON.stringify(values)}` : key;

function firstMessage(result: { success: boolean; error?: { issues: { message: string }[] } }) {
  return result.success ? null : result.error!.issues[0]?.message;
}

describe('zod-i18n field helpers', () => {
  describe('requiredText', () => {
    it('empty string → tv("required") (not raw Zod)', () => {
      expect(firstMessage(requiredText(tv, 100).safeParse(''))).toBe('required');
    });

    it('over max → tv("tooLong", { max })', () => {
      expect(firstMessage(requiredText(tv, 3).safeParse('abcd'))).toBe(
        'tooLong:{"max":3}',
      );
    });

    it('valid value passes', () => {
      expect(requiredText(tv, 100).safeParse('Acme').success).toBe(true);
    });

    it('without a max, only enforces required', () => {
      expect(firstMessage(requiredText(tv).safeParse(''))).toBe('required');
      expect(requiredText(tv).safeParse('x'.repeat(5000)).success).toBe(true);
    });
  });

  describe('emailText', () => {
    it('malformed email → tv("invalidEmail")', () => {
      const messages = emailText(tv)
        .safeParse('not-an-email')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .error?.issues.map((i: any) => i.message);
      expect(messages).toContain('invalidEmail');
    });

    it('over max → tv("tooLong", { max })', () => {
      expect(firstMessage(emailText(tv, 254).safeParse(`${'a'.repeat(260)}@x.co`))).toBe(
        'tooLong:{"max":254}',
      );
    });

    it('valid email passes', () => {
      expect(emailText(tv).safeParse('a@b.co').success).toBe(true);
    });
  });

  describe('boundedText', () => {
    it('over max → tv("tooLong", { max })', () => {
      expect(firstMessage(boundedText(tv, 2).safeParse('xyz'))).toBe(
        'tooLong:{"max":2}',
      );
    });

    it('empty string passes (caller decides required/optional)', () => {
      expect(boundedText(tv, 20).safeParse('').success).toBe(true);
    });
  });

  describe('passwordPairFields', () => {
    it('over 256 chars → threaded tooLong message (not raw Zod)', () => {
      const { newPassword } = passwordPairFields('TOO_SHORT', 'TOO_LONG');
      const messages = newPassword
        .safeParse('a'.repeat(257))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .error?.issues.map((i: any) => i.message);
      expect(messages).toContain('TOO_LONG');
    });

    it('under 12 chars → threaded tooShort message', () => {
      const { newPassword } = passwordPairFields('TOO_SHORT', 'TOO_LONG');
      const messages = newPassword
        .safeParse('short')
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .error?.issues.map((i: any) => i.message);
      expect(messages).toContain('TOO_SHORT');
    });
  });
});
