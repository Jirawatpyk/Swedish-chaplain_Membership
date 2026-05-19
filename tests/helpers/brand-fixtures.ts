/**
 * Round-3 deferred-fix closure — branded-type test fixture helpers.
 *
 * Wraps the smart constructors (`asEventId`, `asRegistrationId`,
 * `asMemberId`, `asUserId`) with UUID-v4 validation so test fixtures
 * declare branded values with the same runtime safety the production
 * route handlers enforce via their inline UUID_V4 regex checks.
 *
 * **Why this exists** (Round-3 type-design follow-up):
 *
 * Pre-existing test fixtures use raw casts:
 * ```ts
 * const MEMBER_A = '33333333-3333-4333-8333-333333333333' as MemberId;
 * ```
 *
 * The cast bypasses the brand smart constructor entirely. If a
 * fixture string is mis-typed (e.g. `'33333333-3333-4333-8333-3333'`
 * — too short, missing chars), the test passes through unchanged
 * until a runtime DB FK check OR the production smart constructor
 * (which only validates length, not UUID shape) lets it through
 * silently. Using `mkMemberId(...)` instead:
 *
 * ```ts
 * const MEMBER_A = mkMemberId('33333333-3333-4333-8333-333333333333');
 * ```
 *
 * ...forces UUID-v4 validation at fixture-load time. Mis-typed
 * fixtures fail loud at test boot rather than masquerading as
 * production data.
 *
 * **Adoption** (not all-at-once):
 *
 * New F6 tests SHOULD use these helpers. Existing tests can migrate
 * opportunistically — there's no urgency because the fixtures are
 * static-known-good and the production smart constructors don't
 * actually validate UUID shape either (per `branded-types.ts §
 * trust-convention`). The helpers are STRICTER than production by
 * design — they're a fixture-construction defence, not a runtime
 * contract change.
 *
 * **Convention coverage**: This complements the `// brand-boundary:
 * <validation-source>` audit convention documented in
 * `branded-types.ts`. Production callsites use that comment to
 * document where validation happened; tests use `mk*` to make
 * validation explicit at fixture declaration.
 */
import type { EventId, RegistrationId } from '@/modules/events';
import {
  asEventId,
  asRegistrationId,
} from '@/modules/events/domain/branded-types';
import { asMemberId, type MemberId } from '@/modules/members';
import { asUserId, type UserId } from '@/modules/auth';

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function assertUuidV4(value: string, brand: string): void {
  if (!UUID_V4_REGEX.test(value)) {
    throw new Error(
      `mk${brand} fixture failed UUID-v4 validation: "${value}" — ` +
        `expected RFC 4122 v4 (8-4-4-4-12 hex with version=4 + ` +
        `variant=8/9/a/b). Check the fixture constant for typos.`,
    );
  }
}

/**
 * Construct a branded `EventId` from a UUID-v4 string. Throws at
 * fixture-load time if the string is not a valid UUID v4.
 */
export function mkEventId(uuid: string): EventId {
  assertUuidV4(uuid, 'EventId');
  return asEventId(uuid);
}

/**
 * Construct a branded `RegistrationId` from a UUID-v4 string. Throws
 * at fixture-load time on shape violation.
 */
export function mkRegistrationId(uuid: string): RegistrationId {
  assertUuidV4(uuid, 'RegistrationId');
  return asRegistrationId(uuid);
}

/**
 * Construct a branded `MemberId` from a UUID-v4 string. Throws at
 * fixture-load time on shape violation.
 */
export function mkMemberId(uuid: string): MemberId {
  assertUuidV4(uuid, 'MemberId');
  return asMemberId(uuid);
}

/**
 * Construct a branded `UserId` from a UUID-v4 string. Throws at
 * fixture-load time on shape violation.
 */
export function mkUserId(uuid: string): UserId {
  assertUuidV4(uuid, 'UserId');
  return asUserId(uuid);
}
