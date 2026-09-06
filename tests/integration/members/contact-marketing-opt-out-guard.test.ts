/**
 * 108 PR-D review cycle 13 (whole-branch review MEDIUM-1) — the FR-025
 * AMENDMENT is enforced UNDER THE ROW LOCK, not only by the use case's
 * pre-read.
 *
 * The use case decides "staff cannot lift a self opt-out" from a read taken
 * OUTSIDE the transaction; two round-trips later (suppression lookup, new tx)
 * it writes. A contact who commits `optOut: true` from the portal in that
 * window used to have their objection cleared by the staff "on" that had
 * already been approved. The repo now takes the actor's source and re-checks
 * the guard on the locked row: staff "on" over a `self` record is refused
 * with no write; the person's own "on" still goes through.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runInTenant } from '@/lib/db';
import { asContactId, drizzleContactRepo } from '@/modules/members';
import { RECEIVES_MARKETING } from '@/modules/members/domain/contact';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { seedPortalMemberWithContact, seedPortalPlan } from '../helpers/portal-seed';

const NOW = new Date('2026-09-06T05:00:00Z');

describe('108 PR-D — self opt-out precedence is enforced under the row lock (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  let contactId: string;
  const planId = `mkt-g-${randomUUID().slice(0, 6)}`;

  beforeAll(async () => {
    admin = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    await seedPortalPlan(tenant.ctx.slug, admin.userId, planId);
    const seeded = await seedPortalMemberWithContact(tenant, planId);
    contactId = seeded.contactId;
    // The person objects (portal) — the record the race would have cleared.
    const r = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(
        tx,
        asContactId(contactId),
        { optedOutAt: NOW, source: 'self', byUserId: admin.userId as never },
        { actorSource: 'self' },
      ),
    );
    if (!r.ok) throw new Error(`seed opt-out failed: ${r.error.code}`);
  }, 120_000);

  afterAll(async () => {
    await tenant?.cleanup().catch(() => {});
    if (admin) await deleteTestUser(admin).catch(() => {});
  });

  it('STAFF "on" over a self opt-out → refused_self_opted_out, the row is untouched', async () => {
    const r = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), RECEIVES_MARKETING, {
        actorSource: 'staff',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('refused_self_opted_out');
    const after = await drizzleContactRepo.findById(tenant.ctx, asContactId(contactId));
    if (!after.ok) throw new Error('expected contact');
    expect(after.value.marketing).toEqual({
      optedOutAt: NOW,
      source: 'self',
      byUserId: admin.userId,
    });
  });

  it('STAFF "off" over a self opt-out → unchanged (the person\'s record is kept)', async () => {
    const r = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(
        tx,
        asContactId(contactId),
        { optedOutAt: new Date('2026-09-06T06:00:00Z'), source: 'staff', byUserId: admin.userId as never },
        { actorSource: 'staff' },
      ),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('unchanged');
  });

  it('the person\'s OWN "on" over their self opt-out → changed', async () => {
    const r = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), RECEIVES_MARKETING, {
        actorSource: 'self',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('changed');
    expect(r.value.contact.marketing).toEqual(RECEIVES_MARKETING);
  });

  it('STAFF "on" over a STAFF opt-out → changed (only the person\'s own objection is protected)', async () => {
    await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(
        tx,
        asContactId(contactId),
        { optedOutAt: NOW, source: 'staff', byUserId: admin.userId as never },
        { actorSource: 'staff' },
      ),
    );
    const r = await runInTenant(tenant.ctx, (tx) =>
      drizzleContactRepo.setMarketingOptOutInTx(tx, asContactId(contactId), RECEIVES_MARKETING, {
        actorSource: 'staff',
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.outcome).toBe('changed');
  });
});
