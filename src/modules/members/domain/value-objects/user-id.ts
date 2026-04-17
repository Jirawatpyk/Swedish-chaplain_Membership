/**
 * UserId — opaque branded identifier for F1 auth users.
 *
 * Plan E2 (see specs/005-members-contacts/plan.md § Constitution Check III):
 * members Domain MUST NOT import `@/modules/auth/domain/**`. The cross-module
 * import boundary is enforced by an ESLint `no-restricted-imports` rule
 * scoped to `src/modules/members/**`.
 *
 * This type is structurally compatible with F1's UUID strings but nominally
 * distinct from any raw string — flows that want a linked user must go
 * through `asUserId(rawFromAuthBarrel)` at the Application layer, which
 * receives the raw UUID from the auth module's public barrel (not from
 * its Domain).
 */
import { err, ok, type Result } from '@/lib/result';

declare const UserIdBrand: unique symbol;
export type UserId = string & { readonly [UserIdBrand]: true };

export type UserIdError = { code: 'userId.invalid_uuid' };

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function asUserId(raw: string): Result<UserId, UserIdError> {
  if (!UUID_REGEX.test(raw)) return err({ code: 'userId.invalid_uuid' });
  return ok(raw.toLowerCase() as UserId);
}
