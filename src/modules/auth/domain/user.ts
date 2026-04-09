/**
 * UserAccount entity + status state machine (data-model.md § 2.2 / § 2.3).
 *
 * Pure types only — Domain layer. The Application layer (sign-in,
 * disable-user, etc.) is responsible for enforcing transitions and
 * invariants (e.g., "at least one active admin always exists").
 */

import type { EmailAddress, UserId } from './branded';
import type { Role } from './role';

export const USER_STATUSES = ['pending', 'active', 'disabled'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export interface UserAccount {
  readonly id: UserId;
  readonly email: EmailAddress;
  readonly role: Role;
  readonly status: UserStatus;
  readonly createdAt: Date;
  readonly lastSignInAt: Date | null;
  readonly lastPasswordChangedAt: Date | null;
  readonly failedSignInCount: number;
  readonly lockedUntil: Date | null;
  readonly displayName: string | null;
}

export function isUserStatus(value: string): value is UserStatus {
  return (USER_STATUSES as readonly string[]).includes(value);
}

/**
 * Allowed status transitions (data-model.md § 4.1):
 *
 *   pending  → active   (redeem invite)
 *   active   → disabled (admin disable)
 *   disabled → active   (admin re-enable)
 *
 * Note: pending → disabled is NOT allowed; pending users can only be
 * activated or have their invitation expire (→ stays pending).
 */
export function canTransition(from: UserStatus, to: UserStatus): boolean {
  if (from === to) return false;
  if (from === 'pending' && to === 'active') return true;
  if (from === 'active' && to === 'disabled') return true;
  if (from === 'disabled' && to === 'active') return true;
  return false;
}

/**
 * Lockout helpers — based on `failedSignInCount` + `lockedUntil` rather
 * than a status change (data-model.md § 2.2 "Lockout is NOT a status").
 */
export function isLocked(user: UserAccount, now: Date): boolean {
  return user.lockedUntil !== null && user.lockedUntil.getTime() > now.getTime();
}
