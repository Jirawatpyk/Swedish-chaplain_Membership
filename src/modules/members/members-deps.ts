/**
 * Members module — composition root (T050).
 *
 * Wires every Infrastructure singleton (drizzle repos, audit adapter,
 * plan-lookup stub) + the default Clock + a UUID v4 id factory into
 * the `MembersDeps` bag that Application use cases receive.
 *
 * Tests construct their own deps inline with stubs. They never import
 * this module — that's why it isn't re-exported from the public barrel.
 */

import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@/modules/tenants';
import { drizzleMemberRepo } from './infrastructure/db/drizzle-member-repo';
import { drizzleContactRepo } from './infrastructure/db/drizzle-contact-repo';
import { drizzleAuditAdapter } from './infrastructure/audit/audit-adapter';
import { drizzleTimelineRepo } from './infrastructure/timeline/drizzle-timeline-repo';
import { plansBarrelAdapter } from './infrastructure/adapters/plan-lookup-adapter';
import { resendEmailPort } from './infrastructure/adapters/resend-email-port';
import { authSessionRevocationPort } from './infrastructure/adapters/auth-session-revocation-port';
import { userEmailAdapter } from './infrastructure/adapters/user-email-adapter';
import { emailChangeTokenAdapter } from './infrastructure/adapters/email-change-token-adapter';
import { drizzleInvitationCascadePort } from './infrastructure/adapters/invitation-cascade-adapter';
import { f7BroadcastsCascadeAdapter } from './infrastructure/adapters/broadcasts-cascade-adapter';
import { f8RenewalsCascadeAdapter } from './infrastructure/adapters/renewals-cascade-adapter';
import type { MemberRepo } from './application/ports/member-repo';
import type { ContactRepo } from './application/ports/contact-repo';
import type { AuditPort } from './application/ports/audit-port';
import type { ClockPort } from './application/ports/clock-port';
import type { PlanLookupPort } from './application/ports/plan-lookup-port';
import type { EmailPort } from './application/ports/email-port';
import type { SessionRevocationPort } from './application/ports/session-revocation-port';
import type { UserEmailPort } from './application/ports/user-email-port';
import type { EmailChangeTokenPort } from './application/ports/email-change-token-port';
import type { InvitationCascadePort } from './application/ports/invitation-cascade-port';
import type { BroadcastsCascadePort } from './application/ports/broadcasts-cascade-port';
import type { RenewalsCascadePort } from './application/ports/renewals-cascade-port';
import type { TimelinePort } from './application/ports/timeline-port';
import type { MemberId } from './domain/member';
import type { ContactId } from './domain/contact';

export type MembersDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  contactRepo: ContactRepo;
  audit: AuditPort;
  plans: PlanLookupPort;
  emails: EmailPort;
  sessions: SessionRevocationPort;
  userEmails: UserEmailPort;
  tokens: EmailChangeTokenPort;
  invitations: InvitationCascadePort;
  /** F7 in-flight broadcasts cascade (T178a / Coverage Gap C2). */
  broadcastsCascade: BroadcastsCascadePort;
  /**
   * F8 in-flight renewal-cycles cascade (Phase 9 / T238). Cancels the
   * at-most-one active cycle owned by an archived/erased member;
   * reuses `renewal_cycle_cancelled` audit with a system-actor +
   * cascade-reason discriminator. Required in production deps; tests
   * may inject `noopRenewalsCascadeAdapter` from the same adapter
   * module.
   */
  renewalsCascade: RenewalsCascadePort;
  timeline: TimelinePort;
  clock: ClockPort;
  idFactory: {
    memberId(): MemberId;
    contactId(): ContactId;
  };
};

const systemClock: ClockPort = {
  now: () => new Date(),
};

const systemIdFactory = {
  // Node.js built-in UUID v4 (crypto.randomUUID). Primary key ordering
  // relies on the DB-generated `created_at` timestamp, not UUID sort order.
  memberId: (): MemberId => randomUUID() as MemberId,
  contactId: (): ContactId => randomUUID() as ContactId,
};

/**
 * Public-path composition entry — returned value exposes the subset
 * of adapters that standalone (non-tenant) API routes need:
 *   - `findActiveToken(tokenId)` for the email-change revert +
 *     verification endpoints which receive a public URL token and
 *     have to derive the tenant from the token row.
 *
 * Keeps API routes out of direct infrastructure imports (Constitution
 * Principle III / barrel discipline).
 */
export function buildPublicEmailChangeLookup() {
  return {
    findActiveToken: emailChangeTokenAdapter.findActiveById,
  };
}

export function buildMembersDeps(tenant: TenantContext): MembersDeps {
  return {
    tenant,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: drizzleAuditAdapter,
    plans: plansBarrelAdapter,
    emails: resendEmailPort,
    sessions: authSessionRevocationPort,
    userEmails: userEmailAdapter,
    tokens: emailChangeTokenAdapter,
    invitations: drizzleInvitationCascadePort,
    broadcastsCascade: f7BroadcastsCascadeAdapter,
    renewalsCascade: f8RenewalsCascadeAdapter,
    timeline: drizzleTimelineRepo,
    clock: systemClock,
    idFactory: systemIdFactory,
  };
}

/**
 * Minimal subset of `MembersDeps` that `getMember` actually consumes —
 * used by routes that only need a tenant-scoped member probe (e.g.
 * `/api/members/[memberId]/invoices` cross-tenant verification) so we
 * don't allocate the full deps bag (resend, argon2 hashing, session
 * revocation, invitation cascade, timeline repo) on every request.
 * Keeps Vercel function cold-start lean.
 */
export type MemberProbeDeps = Pick<
  MembersDeps,
  'tenant' | 'memberRepo' | 'contactRepo' | 'audit'
>;

export function buildMemberProbeDeps(tenant: TenantContext): MemberProbeDeps {
  return {
    tenant,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: drizzleAuditAdapter,
  };
}
