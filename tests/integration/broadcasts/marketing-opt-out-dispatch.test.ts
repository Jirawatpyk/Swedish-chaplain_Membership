/**
 * 108 PR-D review cycle 10 (privacy B-1 / security HIGH-1) — the per-contact
 * marketing opt-out (FR-022a) is honoured AT DISPATCH, proved on live Neon
 * through the REAL F7→F3 bridge (`membersBridge`), the real contacts repo and
 * the real suppression repo. No fixture sits in the path that decides who
 * receives a broadcast.
 *
 * Pinned:
 *   - all_members: a member whose primary contact opted out (self OR staff)
 *     is dropped, counted under `droppedByPreference`, and is NOT an orphan;
 *   - custom list: an opted-out SECONDARY contact's address is dropped too;
 *   - the repo matches on lower(email) (the stored address may be mixed
 *     case), ignores removed rows, and — RLS — never sees another tenant's
 *     opt-out.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { resolveSegmentRecipients } from '@/modules/broadcasts';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import {
  asContactId,
  drizzleContactRepo,
  filterMarketingOptedOutEmails,
} from '@/modules/members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTwoTestTenants, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const NOW = new Date('2026-09-06T03:00:00Z');

async function optOut(
  tenant: TestTenant,
  contactId: string,
  source: 'self' | 'staff',
  byUserId: string,
): Promise<void> {
  const r = await runInTenant(tenant.ctx, (tx) =>
    drizzleContactRepo.setMarketingOptOutInTx(
      tx,
      asContactId(contactId),
      { kind: 'off', actor: source, byUserId: byUserId as never, at: NOW },
    ),
  );
  if (!r.ok) throw new Error(`opt-out seed failed: ${r.error.code}`);
}

async function insertContact(
  tenant: TestTenant,
  memberId: string,
  email: string,
  opts: { isPrimary?: boolean; removedAt?: Date | null } = {},
): Promise<string> {
  const contactId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(contacts).values({
      tenantId: tenant.ctx.slug,
      contactId,
      memberId,
      firstName: 'Extra',
      lastName: 'Contact',
      email,
      phone: null,
      roleTitle: null,
      preferredLanguage: 'en',
      isPrimary: opts.isPrimary ?? false,
      dateOfBirth: null,
      linkedUserId: null,
      removedAt: opts.removedAt ?? null,
    });
  });
  return contactId;
}

describe('108 PR-D B-1 — marketing opt-out honoured at dispatch (live Neon, real bridge)', () => {
  let tenantA: TestTenant;
  let tenantB: TestTenant;
  let admin: TestUser;
  const planId = `mkt-b1-${randomUUID().slice(0, 6)}`;
  const tag = randomUUID().slice(0, 8);

  const keepEmail = `keep-${tag}@example.test`;
  const selfOffEmail = `selfoff-${tag}@example.test`;
  const staffOffEmail = `staffoff-${tag}@example.test`;
  const secondaryOffEmail = `sec-off-${tag}@example.test`;
  const mixedCaseEmail = `Mixed.Case-${tag}@Example.test`;
  const removedEmail = `removed-${tag}@example.test`;
  const tenantBEmail = `other-tenant-${tag}@example.test`;

  let keepMemberId: string;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    const pair = await createTwoTestTenants();
    tenantA = pair.a;
    tenantB = pair.b;
    await seedPortalPlan(tenantA.ctx.slug, admin.userId, planId);
    await seedPortalPlan(tenantB.ctx.slug, admin.userId, planId);

    const keep = await seedPortalMemberWithContact(tenantA, planId, { contactEmail: keepEmail });
    keepMemberId = keep.memberId;
    const selfOff = await seedPortalMemberWithContact(tenantA, planId, {
      contactEmail: selfOffEmail,
    });
    const staffOff = await seedPortalMemberWithContact(tenantA, planId, {
      contactEmail: staffOffEmail,
    });
    await optOut(tenantA, selfOff.contactId, 'self', admin.userId);
    await optOut(tenantA, staffOff.contactId, 'staff', admin.userId);

    // A secondary contact of the KEPT member, opted out — only a custom list
    // (or an attendee list) can name it; the member-based segments never do.
    const secondary = await insertContact(tenantA, keepMemberId, secondaryOffEmail);
    await optOut(tenantA, secondary.toString(), 'self', admin.userId);

    // Mixed-case stored address, opted out — the lookup must match on lower().
    const mixed = await insertContact(tenantA, keepMemberId, mixedCaseEmail);
    await optOut(tenantA, mixed, 'staff', admin.userId);

    // Removed contact that once opted out — no longer a live preference.
    const removed = await insertContact(tenantA, keepMemberId, removedEmail);
    await optOut(tenantA, removed, 'staff', admin.userId);
    await runInTenant(tenantA.ctx, (tx) =>
      drizzleContactRepo.removeInTx(tx, asContactId(removed)),
    );

    // Tenant B has its own opted-out contact — invisible to tenant A (RLS).
    const other = await seedPortalMemberWithContact(tenantB, planId, {
      contactEmail: tenantBEmail,
    });
    await optOut(tenantB, other.contactId, 'staff', admin.userId);
  }, 120_000);

  afterAll(async () => {
    await tenantA?.cleanup().catch(() => {});
    await tenantB?.cleanup().catch(() => {});
    if (admin) await deleteTestUser(admin).catch(() => {});
  });

  function deps(tenant: TestTenant) {
    return {
      tenant: tenant.ctx,
      audienceMode: 'primary_only' as const,
      membersBridge,
      eventAttendees: eventAttendeesStub,
      marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
    };
  }

  it('all_members: both opted-out primaries are dropped and counted; the member is not an orphan', async () => {
    const result = await resolveSegmentRecipients(deps(tenantA), {
      segment: { kind: 'all_members' },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower(keepEmail)]);
    expect(result.value.estimatedCount).toBe(1);
    expect(result.value.droppedByPreference).toBe(2);
    expect(result.value.orphans).toEqual([]);
  });

  it('custom list: an opted-out SECONDARY contact is dropped; the kept primary stays', async () => {
    const result = await resolveSegmentRecipients(deps(tenantA), {
      segment: { kind: 'custom', emails: [keepEmail, secondaryOffEmail, selfOffEmail] },
      phase: 'dispatch',
      requestingMemberId: null,
      customRecipients: [
        unsafeBrandEmailLower(keepEmail),
        unsafeBrandEmailLower(secondaryOffEmail),
        unsafeBrandEmailLower(selfOffEmail),
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recipients).toEqual([unsafeBrandEmailLower(keepEmail)]);
    expect(result.value.droppedByPreference).toBe(2);
  });

  it('repo: matches on lower(email), ignores removed rows, and RLS hides the other tenant', async () => {
    const r = await filterMarketingOptedOutEmails(
      { tenant: tenantA.ctx, contactRepo: drizzleContactRepo },
      [
        keepEmail,
        mixedCaseEmail.toLowerCase(),
        removedEmail,
        tenantBEmail,
        `never-seen-${tag}@example.test`,
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect([...r.value].sort()).toEqual([mixedCaseEmail.toLowerCase()]);
  });

  it('bridge: the same answer comes back branded, tenant-scoped', async () => {
    const set = await membersBridge.filterMarketingOptedOut(tenantA.ctx, [
      unsafeBrandEmailLower(keepEmail),
      unsafeBrandEmailLower(staffOffEmail),
      unsafeBrandEmailLower(tenantBEmail),
    ]);
    expect([...set]).toEqual([unsafeBrandEmailLower(staffOffEmail)]);
  });
});
