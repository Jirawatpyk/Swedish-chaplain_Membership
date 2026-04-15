/**
 * Members module — composition root (T050).
 *
 * Wires every Infrastructure singleton (drizzle repos, audit adapter,
 * plan-lookup stub) + the default Clock + a UUID v7 id factory into
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
import { plansBarrelAdapter } from './infrastructure/adapters/plan-lookup-adapter';
import type { MemberRepo } from './application/ports/member-repo';
import type { ContactRepo } from './application/ports/contact-repo';
import type { AuditPort } from './application/ports/audit-port';
import type { ClockPort } from './application/ports/clock-port';
import type { PlanLookupPort } from './application/ports/plan-lookup-port';
import type { MemberId } from './domain/member';
import type { ContactId } from './domain/contact';

export type MembersDeps = {
  tenant: TenantContext;
  memberRepo: MemberRepo;
  contactRepo: ContactRepo;
  audit: AuditPort;
  plans: PlanLookupPort;
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
  // Node.js built-in UUID v4; v7 (time-ordered) lands when Node's crypto
  // adds it (post-22). UUID v4 remains deterministic-enough for audit
  // ordering purposes in B.1 — primary keys use the DB timestamp.
  memberId: (): MemberId => randomUUID() as MemberId,
  contactId: (): ContactId => randomUUID() as ContactId,
};

export function buildMembersDeps(tenant: TenantContext): MembersDeps {
  return {
    tenant,
    memberRepo: drizzleMemberRepo,
    contactRepo: drizzleContactRepo,
    audit: drizzleAuditAdapter,
    plans: plansBarrelAdapter,
    clock: systemClock,
    idFactory: systemIdFactory,
  };
}
