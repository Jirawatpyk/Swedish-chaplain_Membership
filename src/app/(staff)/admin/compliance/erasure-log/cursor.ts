/**
 * COMP-1 US3-D — keyset cursor codec for the DPO erasure-evidence log page.
 *
 * Co-located, non-route pure module (Next ignores non-`page`/`route` files for
 * routing). Encodes/decodes the `{ erasedAt: Date; memberId }` keyset cursor as
 * a URL-safe base64 string for the "load more" link.
 *
 * `decodeCursor` is FAIL-CLOSED + NEVER THROWS — a tampered/garbage cursor
 * decodes to `undefined` and the page renders the first page. The decoded
 * `memberId` flows into `lt(members.member_id, cursor.memberId)` against a
 * Postgres `uuid` column; a non-UUID value would throw `22P02`
 * (`invalid input syntax for type uuid`) and, since the page's read is
 * fail-closed with no try/catch, propagate to a 500. So `decodeCursor`
 * UUID-shape-guards `memberId` (mirroring the F9 audit reader's `ACTOR_UUID_RE`,
 * `src/modules/insights/application/use-cases/audit-query.ts`) and rejects a
 * malformed id the same way it rejects a malformed date.
 */
import type { ErasedMembersCursor } from '@/modules/members';

/**
 * Canonical UUID shape (mirrors the F9 audit reader's `ACTOR_UUID_RE`). A
 * decoded `memberId` that is a well-formed string but not a UUID is rejected so
 * it never reaches the `uuid`-column keyset predicate.
 */
const MEMBER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function encodeCursor(c: ErasedMembersCursor): string {
  return Buffer.from(
    JSON.stringify({ erasedAt: c.erasedAt.toISOString(), memberId: c.memberId }),
    'utf8',
  ).toString('base64url');
}

export function decodeCursor(raw: string): ErasedMembersCursor | undefined {
  if (raw === '') return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'erasedAt' in parsed &&
      'memberId' in parsed &&
      typeof (parsed as { erasedAt: unknown }).erasedAt === 'string' &&
      typeof (parsed as { memberId: unknown }).memberId === 'string'
    ) {
      const memberId = (parsed as { memberId: string }).memberId;
      // UUID-shape guard — a non-UUID memberId would throw Postgres 22P02 at
      // the keyset predicate, which the fail-closed page would surface as a 500.
      if (!MEMBER_UUID_RE.test(memberId)) return undefined;
      const erasedAt = new Date((parsed as { erasedAt: string }).erasedAt);
      if (Number.isNaN(erasedAt.getTime())) return undefined;
      return { erasedAt, memberId };
    }
  } catch {
    // Malformed cursor → treat as no cursor (first page). Never surface a 500.
  }
  return undefined;
}
