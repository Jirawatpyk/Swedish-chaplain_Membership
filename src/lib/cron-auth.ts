/**
 * Constant-time Bearer-token check for cron routes.
 *
 * Length-check first because `timingSafeEqual` throws on length
 * mismatch; treats null/missing/short/long header as auth failure
 * with no timing leak on `CRON_SECRET` enumeration.
 */
import { timingSafeEqual } from 'node:crypto';

export function verifyCronBearer(
  authHeader: string | null | undefined,
  expectedSecret: string,
): boolean {
  const expectedHeader = `Bearer ${expectedSecret}`;
  const provided = authHeader ?? '';
  if (provided.length !== expectedHeader.length) return false;
  return timingSafeEqual(
    Buffer.from(provided, 'utf8'),
    Buffer.from(expectedHeader, 'utf8'),
  );
}
