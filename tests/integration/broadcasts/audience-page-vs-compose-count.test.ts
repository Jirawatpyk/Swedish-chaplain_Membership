/**
 * 108 PR-C T105 (SC-011) — the Marketing audience page and the compose-time
 * count answer "who will receive the next All-members broadcast?" with the
 * SAME number for the same tenant state: the page's eligible-and-on view
 * (`{ eligible: true, state: 'on' }`) equals `resolveSegmentRecipients`
 * (`all_contacts`, no requesting member — SC-011 is BEFORE sender
 * self-exclusion). Two code paths, two modules (F3 query vs F7 resolver
 * through the real bridge and the real suppression repo), one truth.
 *
 * Seeded so every exclusion axis is exercised on both sides: a staff opt-out,
 * a suppressed address, an orphan member (no contacts), an inactive member,
 * and a second live secondary that must be counted once.
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { buildMarketingAudienceDeps } from '@/lib/contact-marketing-deps';
import { resolveSegmentRecipients } from '@/modules/broadcasts';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { makeDrizzleMarketingUnsubscribesRepo } from '@/modules/broadcasts/infrastructure/db/drizzle-marketing-unsubscribes-repo';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { listMarketingAudience } from '@/modules/members';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalPlan } from '../helpers/portal-seed';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

type ContactSpec = { readonly email: string; readonly isPrimary: boolean; readonly optOut?: 'staff' | 'self' };

async function seedMember(
  tenant: TestTenant,
  planId: string,
  specs: readonly ContactSpec[],
  status: 'active' | 'inactive' = 'active',
  byUserId = '',
): Promise<void> {
  const memberId = randomUUID();
  await runInTenant(tenant.ctx, async (tx) => {
    await tx.insert(members).values({
      tenantId: tenant.ctx.slug,
      memberId,
      memberNumber: nextSeedMemberNumber(),
      companyName: `Parity ${memberId.slice(0, 6)}`,
      country: 'TH',
      planId,
      planYear: 2026,
      status,
      archivedAt: null,
    });
    if (specs.length === 0) return;
    await tx.insert(contacts).values(
      specs.map((s) => ({
        tenantId: tenant.ctx.slug,
        contactId: randomUUID(),
        memberId,
        firstName: 'Sim',
        lastName: s.email.slice(0, 8),
        email: s.email,
        preferredLanguage: 'en' as const,
        isPrimary: s.isPrimary,
        removedAt: null,
        marketingOptOutAt: s.optOut ? new Date('2026-09-01T00:00:00Z') : null,
        marketingOptOutSource: s.optOut ?? null,
        marketingOptOutByUserId: s.optOut ? byUserId : null,
      })),
    );
  });
}

describe('108 PR-C T105 — SC-011: audience page (eligible, on) = compose count before self-exclusion (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `par-${randomUUID().slice(0, 6)}`;
  const tag = randomUUID().slice(0, 8);
  const p1 = `par-p1-${tag}@example.test`;
  const s1 = `par-s1-${tag}@example.test`;
  const s2StaffOff = `par-s2-off-${tag}@example.test`;
  const p2Suppressed = `par-p2-unsub-${tag}@example.test`;
  const p4Inactive = `par-p4-inactive-${tag}@example.test`;
  const pN = `par-pn-${tag}@example.test`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    await seedMember(tenant, planId, [
      { email: p1, isPrimary: true },
      { email: s1, isPrimary: false },
      { email: s2StaffOff, isPrimary: false, optOut: 'staff' },
    ], 'active', admin.userId);
    await seedMember(tenant, planId, [{ email: p2Suppressed, isPrimary: true }]);
    await seedMember(tenant, planId, []); // orphan: eligible, no contacts
    await seedMember(tenant, planId, [{ email: p4Inactive, isPrimary: true }], 'inactive');
    await seedMember(tenant, planId, [{ email: pN, isPrimary: true }]);
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values({
        tenantId: tenant.ctx.slug,
        emailLower: p2Suppressed,
        memberId: null,
        contactId: null,
        reason: 'recipient_initiated',
        reasonText: null,
        sourceBroadcastId: null,
        sourceTokenHash: null,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('the page total (eligible, on) equals the resolver estimate, and the two lists name the same addresses', async () => {
    const page = await listMarketingAudience(
      { filter: { eligible: true, state: 'on' }, page: 1 },
      buildMarketingAudienceDeps(tenant.ctx),
    );
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.degraded).toBe(false);

    const resolved = await resolveSegmentRecipients(
      {
        tenant: tenant.ctx,
        membersBridge,
        eventAttendees: eventAttendeesStub,
        marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
        audienceMode: 'all_contacts',
      },
      { segment: { kind: 'all_members' }, phase: 'submit', requestingMemberId: null, customRecipients: null },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    // Same number …
    expect(page.value.total).toBe(3);
    expect(resolved.value.estimatedCount).toBe(page.value.total);
    // … and the same people: P1, S1 and N's primary; not the staff-off
    // secondary, not the suppressed primary, not the inactive member, and the
    // orphan contributes nothing on either side.
    const expected = [p1, s1, pN].sort();
    expect([...resolved.value.recipients].sort()).toEqual(expected);
    expect(page.value.rows.map((r) => r.email).sort()).toEqual(expected);
    expect(resolved.value.orphans).toHaveLength(1);
  });
});
