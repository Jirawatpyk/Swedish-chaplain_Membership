/**
 * Constant-time Bearer-token check for cron routes.
 *
 * Byte-length check first because `timingSafeEqual` throws on length
 * mismatch; treats null/missing/short/long header as auth failure
 * with no timing leak on `CRON_SECRET` enumeration.
 *
 * M-8 (review 2026-04-27): compare UTF-8 byte length, not UTF-16
 * String#length. ASCII-only secrets are unaffected, but a multi-byte
 * `CRON_SECRET` (Thai chars / emoji) would mismatch UTF-16 length vs
 * UTF-8 buffer length and let `timingSafeEqual` throw on a different
 * comparison path than the early-return — leaking a timing channel.
 */
import { timingSafeEqual } from 'node:crypto';

export function verifyCronBearer(
  authHeader: string | null | undefined,
  expectedSecret: string,
): boolean {
  const expectedHeader = `Bearer ${expectedSecret}`;
  const provided = authHeader ?? '';
  if (
    Buffer.byteLength(provided, 'utf8') !==
    Buffer.byteLength(expectedHeader, 'utf8')
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expectedHeader, 'utf8'),
  );
}
