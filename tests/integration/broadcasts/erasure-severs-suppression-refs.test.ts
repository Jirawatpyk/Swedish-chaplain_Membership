/**
 * 108 PR-C T104 (FR-056; COMP-1 residual "sever member_id while retaining
 * email_lower" — the deferred US3 decision, now taken) — on live Neon through
 * the production composition (`makeScrubBroadcastContentForMemberDeps`):
 * erasing a member severs `member_id` AND `contact_id` on every suppression
 * row attributed to that member, while the email-keyed row — the promise
 * "we will never contact this address again" (GDPR Art. 21 / PDPA §32) —
 * survives untouched. A peer member's row is not touched; a re-drive is a
 * clean no-op (0 severed, no second audit).
 *
 * Simulated addresses only — no real PII.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import {
  makeScrubBroadcastContentForMemberDeps,
  scrubBroadcastContentForMember,
} from '@/modules/broadcasts';
import { marketingUnsubscribes } from '@/modules/broadcasts/infrastructure/schema';
import { asMemberId } from '@/modules/members';
import {
  createActiveTestUser,
  deleteTestUser,
  type TestUser,
} from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

type Row = { member_id: string | null; contact_id: string | null; reason: string };

describe('108 PR-C T104 — erasure severs suppression back-references, keeps the address (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `sev-${randomUUID().slice(0, 6)}`;
  const tag = randomUUID().slice(0, 8);
  const erasedEmail = `sev-erased-${tag}@example.test`;
  const peerEmail = `sev-peer-${tag}@example.test`;
  let erased: { memberId: string; contactId: string };
  let peer: { memberId: string; contactId: string };

  async function rowFor(email: string): Promise<Row> {
    const rows = (await db.execute(sql`
      SELECT member_id::text AS member_id, contact_id::text AS contact_id, reason::text AS reason
        FROM marketing_unsubscribes
       WHERE tenant_id = ${tenant.ctx.slug} AND email_lower = ${email}
    `)) as unknown as Row[];
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    const e = await seedPortalMemberWithContact(tenant, planId, { contactEmail: erasedEmail });
    const p = await seedPortalMemberWithContact(tenant, planId, { contactEmail: peerEmail });
    erased = { memberId: e.memberId as string, contactId: e.contactId };
    peer = { memberId: p.memberId as string, contactId: p.contactId };
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(marketingUnsubscribes).values([
        {
          tenantId: tenant.ctx.slug,
          emailLower: erasedEmail,
          memberId: erased.memberId,
          contactId: erased.contactId,
          reason: 'recipient_initiated',
          reasonText: null,
          sourceBroadcastId: null,
          sourceTokenHash: null,
        },
        {
          tenantId: tenant.ctx.slug,
          emailLower: peerEmail,
          memberId: peer.memberId,
          contactId: peer.contactId,
          reason: 'recipient_initiated',
          reasonText: null,
          sourceBroadcastId: null,
          sourceTokenHash: null,
        },
      ]),
    );
  }, 120_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
    await deleteTestUser(admin).catch(() => {});
  }, 120_000);

  it('severs member_id + contact_id on the erased member\'s row; the row and the peer\'s row survive intact', async () => {
    const r = await scrubBroadcastContentForMember(
      makeScrubBroadcastContentForMemberDeps(tenant.ctx.slug),
      {
        tenant: tenant.ctx,
        memberId: asMemberId(erased.memberId),
        tombstonedCount: 0,
        reason: 'gdpr_erasure_request',
        initiatedByUserId: admin.userId,
        requestId: randomUUID(),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.suppressionRefsSevered).toBe(1);

    const severed = await rowFor(erasedEmail);
    expect(severed).toEqual({ member_id: null, contact_id: null, reason: 'recipient_initiated' });
    const untouched = await rowFor(peerEmail);
    expect(untouched).toEqual({ member_id: peer.memberId, contact_id: peer.contactId, reason: 'recipient_initiated' });

    const audits = (await db.execute(sql`
      SELECT payload FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug} AND event_type = 'broadcast_content_redacted'::audit_event_type
       ORDER BY timestamp DESC LIMIT 1
    `)) as unknown as Array<{ payload: Record<string, unknown> }>;
    expect(audits[0]?.payload['suppression_refs_severed']).toBe(1);
    expect(JSON.stringify(audits[0]?.payload)).not.toContain(erasedEmail);
  });

  it('a re-drive severs nothing more and emits no second audit', async () => {
    const before = (await db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug} AND event_type = 'broadcast_content_redacted'::audit_event_type
    `)) as unknown as Array<{ n: number }>;
    const r = await scrubBroadcastContentForMember(
      makeScrubBroadcastContentForMemberDeps(tenant.ctx.slug),
      {
        tenant: tenant.ctx,
        memberId: asMemberId(erased.memberId),
        tombstonedCount: 0,
        reason: 'gdpr_erasure_request',
        initiatedByUserId: admin.userId,
        requestId: randomUUID(),
      },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.suppressionRefsSevered).toBe(0);
    const after = (await db.execute(sql`
      SELECT count(*)::int AS n FROM audit_log
       WHERE tenant_id = ${tenant.ctx.slug} AND event_type = 'broadcast_content_redacted'::audit_event_type
    `)) as unknown as Array<{ n: number }>;
    expect(after[0]!.n).toBe(before[0]!.n);
  });
});
