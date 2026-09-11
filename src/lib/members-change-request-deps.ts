/**
 * F114 — composition root for the member change-request use cases
 * (plan § III, research R1).
 *
 * The one cross-module seam this feature has: "who is entitled to review"
 * (FR-011) is every ACTIVE staff user holding `members.write`, which lives
 * on the auth `users` table. The members module must not import
 * `@/modules/auth/domain/**` (ESLint, F3 Plan E2), so the
 * `ReviewerDirectoryPort` adapter is composed HERE — `src/lib/**` is the
 * sanctioned composition layer, the precedent being
 * `contact-marketing-deps.ts` (members ↔ broadcasts).
 *
 * The role set is resolved through the permission EVALUATOR (`canPerform`,
 * the composition-layer name for `hasPermission`), never a role literal:
 * `ROLE_BUNDLES` is not the whole model (super_admin keys come from the
 * evaluator), so the list is `ROLES.filter(r => canPerform(r, 'members.write'))`
 * — today `admin` + `super_admin`; a future bundle change moves the reviewer
 * set with it and no literal here goes stale.
 *
 * Locale: `users` carries no per-user locale, so every reviewer's copy of the
 * staff email renders in the platform default (`defaultLocale`); the port
 * shape already carries `locale`, so a future `users.preferred_locale` needs
 * no port change (research § V4 notes the SweCham reviewer set is 3 people).
 *
 * Routes import from here; Application code never reaches into `src/lib`.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { canPerform } from '@/lib/rbac';
import { defaultLocale } from '@/i18n/config';
import type { TenantContext } from '@/modules/tenants';
import { ROLES, type Role } from '@/modules/auth';
// The F1 `users` table binding — Infrastructure of auth, reached from the
// composition layer only (same documented exception the outbox adapters use).
import { users } from '@/modules/auth/infrastructure/db/schema';
import {
  drizzleChangeRequestRepo,
  drizzleContactRepo,
  drizzleMemberRepo,
  drizzleTenantMemberChangeSettingsRepo,
  f3DrizzleAuditAdapter,
  makeMemberChangeGateResolver,
  type ChangeRequestRepo,
  type ContactRepo,
  type MemberChangeGateResolver,
  type MemberRepo,
  type Reviewer,
  type ReviewerDirectoryPort,
  type TenantMemberChangeSettingsPort,
  type UserId,
} from '@/modules/members';
import type { AuditPort } from '@/modules/members/application/ports/audit-port';
import type { EmailPort } from '@/modules/members/application/ports/email-port';
import type { ClockPort } from '@/modules/members/application/ports/clock-port';
import { resendEmailPort } from '@/modules/members/infrastructure/adapters/resend-email-port';
import { memberChangeApprovalFlag } from '@/modules/members/members-deps';

/** The roles that hold `members.write` — asked of the evaluator, never listed. */
export function reviewerRoles(): readonly Role[] {
  return ROLES.filter((role) => canPerform(role, 'members.write'));
}

/**
 * `ReviewerDirectoryPort` over the auth `users` table: `status = 'active'`
 * and `role` in the evaluator-derived set. The `users` table is cross-tenant
 * by design (F1 — no tenant_id, no RLS), which is why this read uses the
 * plain `db` client and not `runInTenant`; F10's `user_tenants` scopes it.
 */
export function makeReviewerDirectory(): ReviewerDirectoryPort {
  return {
    async listReviewers(): Promise<readonly Reviewer[]> {
      const roles = reviewerRoles();
      if (roles.length === 0) return [];
      const rows = await db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(and(eq(users.status, 'active'), inArray(users.role, [...roles])))
        .orderBy(users.email);
      return rows.map((r) => ({ userId: r.id as UserId, email: r.email, locale: defaultLocale }));
    },
  };
}

export type ChangeRequestDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: ChangeRequestRepo;
  readonly memberRepo: MemberRepo;
  readonly contactRepo: ContactRepo;
  readonly audit: AuditPort;
  readonly emails: EmailPort;
  readonly reviewers: ReviewerDirectoryPort;
  readonly tenantMemberChangeSettings: TenantMemberChangeSettingsPort;
  readonly memberChangeGate: MemberChangeGateResolver;
  readonly clock: ClockPort;
};

const systemClock: ClockPort = { now: () => new Date() };

/** Production composition for every change-request route (portal + staff). */
export function buildChangeRequestDeps(tenant: TenantContext): ChangeRequestDeps {
  return {
    tenant,
    changeRequestRepo: drizzleChangeRequestRepo,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: f3DrizzleAuditAdapter,
    emails: resendEmailPort,
    reviewers: makeReviewerDirectory(),
    tenantMemberChangeSettings: drizzleTenantMemberChangeSettingsRepo,
    memberChangeGate: makeMemberChangeGateResolver({
      flags: memberChangeApprovalFlag,
      tenantMemberSettings: drizzleTenantMemberChangeSettingsRepo,
    }),
    clock: systemClock,
  };
}
