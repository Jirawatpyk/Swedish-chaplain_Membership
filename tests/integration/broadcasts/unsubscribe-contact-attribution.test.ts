/**
 * 108 PR-C T068/T078 (FR-024, US3 s7, SC-006; spec edge case "Unsubscribed
 * address re-added later as a new contact") — on live Neon, through the real
 * suppression repo, the real F7→F3 bridge and the real audit adapter:
 *
 *   - a SECONDARY contact's unsubscribe writes `marketing_unsubscribes.contact_id`
 *     (migration 0297) and `member_id`, and both audit payloads carry
 *     `contactId` — never the address;
 *   - the suppression stays email-keyed and authoritative: after the contact is
 *     removed and the same address is added back as a NEW contact row, the new
 *     row shows "unsubscribed" on the Marketing audience page and the resolver
 *     (all_contacts leg) never lists the address again.
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { buildMarketingAudienceDeps } from '@/lib/contact-marketing-deps';
import {
  f7AuditAdapter,
  makeDrizzleBroadcastsRepo,
  makeDrizzleMarketingUnsubscribesRepo,
  resolveSegmentRecipients,
  systemClock,
  unsubscribeRecipient,
} from '@/modules/broadcasts';
import { membersBridge } from '@/modules/broadcasts/infrastructure/members-bridge';
import { eventAttendeesStub } from '@/modules/broadcasts/infrastructure/event-attendees-stub';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { unsafeBrandEmailLower } from '@/modules/broadcasts/domain/value-objects/email-lower';
import { asMemberId, listMarketingAudience } from '@/modules/members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

describe('108 PR-C T078 — unsubscribe attribution to member + contact (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `attr-${randomUUID().slice(0, 6)}`;
  const tag = randomUUID().slice(0, 8);
  const primaryEmail = `attr-p-${tag}@example.test`;
  const secondaryEmail = `attr-s-${tag}@example.test`;
  let memberId: string;
  let secondaryContactId: string;
  const broadcastId = asBroadcastId(randomUUID());

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    const m = await seedPortalMemberWithContact(tenant, planId, { contactEmail: primaryEmail });
    memberId = m.memberId as string;
    secondaryContactId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: secondaryContactId,
        memberId,
        firstName: 'Sec',
        lastName: 'Ondary',
        email: secondaryEmail,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: null,
        removedAt: null,
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  function deps() {
    return {
      tenant: tenant.ctx,
      broadcastsRepo: makeDrizzleBroadcastsRepo(tenant.ctx.slug),
      marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
      membersBridge,
      audit: f7AuditAdapter,
      clock: systemClock,
      tenantDisplayName: 'Test Chamber',
      tenantSupportEmail: 'support@example.test',
    };
  }

  it('a secondary contact\'s unsubscribe is stored with member_id AND contact_id; the audits carry contactId, never the address', async () => {
    const r = await unsubscribeRecipient(deps(), {
      tenantId: tenant.ctx.slug as never,
      broadcastId,
      emailLower: unsafeBrandEmailLower(secondaryEmail),
      tokenPlaintext: `tok-${tag}`,
      requestId: randomUUID(),
      reasonText: null,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.wasNew).toBe(true);

    const rows = (await db.execute(sql`
      SELECT member_id::text AS member_id, contact_id::text AS contact_id
        FROM marketing_unsubscribes
       WHERE tenant_id = ${tenant.ctx.slug} AND email_lower = ${secondaryEmail}
    `)) as unknown as Array<{ member_id: string | null; contact_id: string | null }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.member_id).toBe(memberId);
    expect(rows[0]!.contact_id).toBe(secondaryContactId);

    const audits = (await db.execute(sql`
      SELECT event_type, payload
        FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug}
         AND event_type IN ('broadcast_unsubscribed'::audit_event_type, 'broadcast_suppression_applied'::audit_event_type)
       ORDER BY timestamp DESC
       LIMIT 2
    `)) as unknown as Array<{ event_type: string; payload: Record<string, unknown> }>;
    expect(audits.map((a) => a.event_type).sort()).toEqual([
      'broadcast_suppression_applied',
      'broadcast_unsubscribed',
    ]);
    for (const a of audits) {
      expect(a.payload['contactId']).toBe(secondaryContactId);
      expect(a.payload['memberId']).toBe(memberId);
      expect(JSON.stringify(a.payload)).not.toContain(secondaryEmail);
    }
  });

  it('removed then re-added under the same address: the new contact row shows "unsubscribed" and is never resolved again', async () => {
    await runInTenant(tenant.ctx, (tx) =>
      tx
        .update(contacts)
        .set({ removedAt: new Date() })
        .where(and(eq(contacts.tenantId, tenant.ctx.slug), eq(contacts.contactId, secondaryContactId))),
    );
    const reAddedId = randomUUID();
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(contacts).values({
        tenantId: tenant.ctx.slug,
        contactId: reAddedId,
        memberId,
        firstName: 'Sec',
        lastName: 'Readded',
        email: secondaryEmail,
        phone: null,
        roleTitle: null,
        preferredLanguage: 'en',
        isPrimary: false,
        dateOfBirth: null,
        linkedUserId: null,
        removedAt: null,
      }),
    );

    const page = await listMarketingAudience(
      { filter: { memberId: asMemberId(memberId), eligible: true }, page: 1 },
      buildMarketingAudienceDeps(tenant.ctx),
    );
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const readded = page.value.rows.find((row) => row.lastName === 'Readded');
    expect(readded?.state).toBe('unsubscribed');

    const resolved = await resolveSegmentRecipients(
      {
        tenant: tenant.ctx,
        membersBridge,
        eventAttendees: eventAttendeesStub,
        marketingUnsubscribes: makeDrizzleMarketingUnsubscribesRepo(tenant.ctx.slug),
        audienceMode: 'all_contacts',
        audienceCeiling: 5000,
      },
      { segment: { kind: 'all_members' }, phase: 'dispatch', requestingMemberId: null, customRecipients: null },
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.recipients).toEqual([unsafeBrandEmailLower(primaryEmail)]);
  }, 60_000);
});
