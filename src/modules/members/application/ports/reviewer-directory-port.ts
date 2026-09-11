/**
 * F114 FR-011 — who is "entitled to review": every ACTIVE staff user holding
 * `members.write` (admin + super_admin today). Implemented in
 * `src/lib/members-change-request-deps.ts` over the auth `users` table — the
 * one cross-module seam this feature has (plan § III), composed in `src/lib`
 * like `contact-marketing-deps.ts`, never a members → auth internal import.
 *
 * `locale` is the language the reviewer's copy of the staff email is rendered
 * in. The auth `users` table carries no per-user locale today, so the adapter
 * answers the platform default; the port shape already carries the field so
 * a future `users.preferred_locale` needs no port change.
 *
 * Under single-tenant deployment "of the tenant" is every such user (spec
 * § Assumptions); F10's `user_tenants` scopes it per tenant.
 */
import type { UserId } from '../../domain/value-objects/user-id';

export type Reviewer = {
  readonly userId: UserId;
  readonly email: string;
  readonly locale: 'en' | 'th' | 'sv';
};

export interface ReviewerDirectoryPort {
  /** Active users holding `members.write`. Empty is a valid (misconfigured-tenant) answer. */
  listReviewers(): Promise<readonly Reviewer[]>;
}
