/**
 * 134-s2 — eraseUser's login sentinel email, `erased+{userId}@erased.invalid`.
 *
 * The one auth-side builder / matcher: the users scrub and the email-change
 * token scrub (user-repo) write it, enableUser refuses it. Derived from the
 * id, so it is unique per login and already lower-case. The members context
 * owns the same format for contacts (`members/domain/erasure-sentinels.ts`);
 * the drift guard tests/unit/auth/erase-user-sentinel-format.test.ts pins
 * both. Pure — no framework imports.
 */
export const ERASED_USER_EMAIL_DOMAIN = 'erased.invalid' as const;

export function erasedUserEmail(userId: string): string {
  return `erased+${userId}@${ERASED_USER_EMAIL_DOMAIN}`;
}

export function isErasedUserEmail(email: string, userId: string): boolean {
  return email === erasedUserEmail(userId);
}
