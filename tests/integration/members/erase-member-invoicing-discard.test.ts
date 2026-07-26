/**
 * COMP-1 §6.2 — Integration: the member-erasure → F4 invoicing draft-discard
 * cascade, against LIVE Neon.
 *
 * The retention decision this pins (GDPR Art.17 / PDPA §33 vs. Thai RD §87/3):
 *
 *   - a `draft` invoice is DISCARDED. It carries no §87 sequence number and no
 *     statutory retention duty, so Art. 5(1)(c) data-minimisation and Art. 17
 *     apply cleanly. Before this cascade existed the draft simply SURVIVED
 *     erasure — a treasurer was told to discard it by hand, and (for a manual
 *     or event draft) nothing ever discarded it automatically.
 *   - an `issued` invoice is RETAINED, byte-for-byte. It is a legally-final
 *     Thai tax document held under the RD §87/3 legal-obligation carve-out,
 *     GDPR Art.17(3)(b). Nothing here deletes, voids, or alters one.
 *
 * Why this MUST be a live-Neon test and not a unit test: the whole cascade
 * rides on a SQL predicate pair (`status='draft'` on the candidate scan, and
 * F4's `deleteInvoiceDraft` re-asserting `status='draft'` inside the DELETE
 * statement). A mocked repo returns whatever the stub was told to return, so a
 * unit test cannot distinguish "discards drafts, retains issued" from
 * "discards everything" — it would pass against a cascade that destroys tax
 * documents. Only a real table with a real issued row proves the line holds.
 *
 * A THIRD invoice belonging to a DIFFERENT, un-erased member is seeded as a
 * blast-radius control: the discard must be member-scoped, not tenant-wide.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db, runInTenant } from '@/lib/db';
import { asMemberId } from '@/modules/members';
import {
  eraseMember,
  type EraseMemberDeps,
} from '@/modules/members/application/use-cases/erase-member';
import { drizzleMemberRepo } from '@/modules/members/infrastructure/db/drizzle-member-repo';
import { drizzleContactRepo } from '@/modules/members/infrastructure/db/drizzle-contact-repo';
import { drizzleAuditAdapter } from '@/modules/members/infrastructure/audit/audit-adapter';
import { authSessionRevocationPort } from '@/modules/members/infrastructure/adapters/auth-session-revocation-port';
import { drizzleInvitationCascadePort } from '@/modules/members/infrastructure/adapters/invitation-cascade-adapter';
import { noopBroadcastsCascadeAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-cascade-adapter';
import { noopRenewalsCascadeAdapter } from '@/modules/members/infrastructure/adapters/renewals-cascade-adapter';
import { noopBroadcastsContentScrubAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-content-scrub-adapter';
import { noopBroadcastsDeliveryTombstoneAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-delivery-tombstone-adapter';
import { authUserErasureAdapter } from '@/modules/members/infrastructure/adapters/auth-user-erasure-adapter';
import { emailChangeTokenAdapter } from '@/modules/members/infrastructure/adapters/email-change-token-adapter';
import { userEmailAdapter } from '@/modules/members/infrastructure/adapters/user-email-adapter';
import { outboxCancelAdapter } from '@/modules/members/infrastructure/adapters/outbox-cancel-adapter';
import { noopEventRegistrationErasureAdapter } from '@/modules/members/infrastructure/adapters/event-registration-erasure-adapter';
import { noopDirectoryErasureAdapter } from '@/modules/members/infrastructure/adapters/directory-erasure-adapter';
import { noopBroadcastsAudienceDerivationAdapter } from '@/modules/members/infrastructure/adapters/broadcasts-audience-derivation-adapter';
import { noopSubprocessorErasureAdapter } from '@/modules/members/infrastructure/adapters/subprocessor-erasure-adapter';
// The REAL adapter under test — NOT a no-op. This is the whole point.
import { invoicingErasureAdapter } from '@/modules/members/infrastructure/adapters/invoicing-erasure-adapter';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { invoices } from '@/modules/invoicing/infrastructure/db/schema-invoices';
import { renewalCycles } from '@/modules/renewals/infrastructure/schema-renewal-cycles';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import { createActiveTestUser, deleteTestUser, type TestUser } from '../helpers/test-users';
import { seedF8MembershipPlan } from '../helpers/seed-f8-plan';
import { DEFAULT_TEST_BENEFIT_MATRIX } from '../helpers/test-benefit-matrix';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const SNAP_TENANT = {
  legal_name_th: 'ท', legal_name_en: 'T', tax_id: '0',
  address_th: 'B', address_en: 'B', logo_blob_key: null,
};
// SIMULATED buyer identity — never a real member's PII.
const SNAP_MEMBER = {
  legal_name: 'C', tax_id: '1', address: 'B',
  primary_contact_name: 'n', primary_contact_email: 't@e.com',
};

const META = { actorUserId: '', requestId: 'req-erase-invoicing' };

describe('COMP-1 §6.2 — erasure discards drafts, retains issued (live Neon)', () => {
  let tenant: TestTenant;
  let admin: TestUser;
  const planId = `erase-inv-${randomUUID().slice(0, 8)}`;

  // The member being erased.
  const erasedMemberId = randomUUID();
  // A peer member who is NOT erased — blast-radius control.
  const peerMemberId = randomUUID();

  const draftInvoiceId = randomUUID();
  const secondDraftInvoiceId = randomUUID();
  const issuedInvoiceId = randomUUID();
  const peerDraftInvoiceId = randomUUID();
  // The shape auto-invoice actually produces: origin='auto_renewal' PLUS a
  // renewal_cycles row stamping `auto_draft_invoice_id`. The other fixtures
  // here are bare `invoices` rows with neither, i.e. the one draft shape this
  // feature never creates.
  const autoDraftInvoiceId = randomUUID();
  const autoCycleId = randomUUID();

  async function seedMember(memberId: string, name: string): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: `${name} ${Date.now()}`,
        country: 'TH',
        planId,
        planYear: 2026,
        status: 'active',
      });
    });
  }

  async function seedDraft(invoiceId: string, memberId: string): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: admin.userId,
        status: 'draft',
        dueDate: null,
      }),
    );
  }

  /**
   * The auto-invoice-shaped draft: `origin='auto_renewal'` plus a
   * `renewal_cycles` row whose `auto_draft_invoice_id` points back at it.
   *
   * Coverage gap this closes: every other draft fixture here is a bare
   * `invoices` row, so nothing proved the cascade handles the shape the feature
   * under review actually emits. It does — the candidate scan filters on member
   * + status only — but "it should" and "it does, against live Neon" are
   * different claims on a compliance path.
   *
   * The cycle's stamp is deliberately left DANGLING after the discard rather
   * than cleared: migration 0259 declares `auto_draft_invoice_id uuid` with no
   * REFERENCES, and `issue-auto-drafted-renewal` documents tolerating a stale
   * stamp, so the dangling pointer is expected and harmless.
   */
  async function seedAutoRenewalDraft(): Promise<void> {
    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId: autoDraftInvoiceId,
        memberId: erasedMemberId,
        planYear: 2026,
        planId,
        draftByUserId: admin.userId,
        status: 'draft',
        origin: 'auto_renewal',
        dueDate: null,
      });
      await tx.insert(renewalCycles).values({
        tenantId: tenant.ctx.slug,
        cycleId: autoCycleId,
        memberId: erasedMemberId,
        status: 'upcoming',
        periodFrom: new Date('2026-01-01T00:00:00Z'),
        periodTo: new Date('2027-01-01T00:00:00Z'),
        expiresAt: new Date('2027-01-01T00:00:00Z'),
        cycleLengthMonths: 12,
        tierAtCycleStart: 'regular',
        planIdAtCycleStart: planId,
        frozenPlanPriceThb: '50000.00',
        frozenPlanTermMonths: 12,
        frozenPlanCurrency: 'THB',
        autoDraftInvoiceId,
      });
    });
  }

  /**
   * A non-draft row must satisfy `invoices_non_draft_has_snapshots` (full
   * pricing + identity snapshots + pdf triple), `invoices_snapshot_has_contact_email`
   * (four string keys on the member snapshot), `invoices_subject_fields_ck`
   * (membership ⇒ member/plan/plan_year set) and `invoices_non_draft_has_doc_kind`.
   */
  async function seedIssued(invoiceId: string, memberId: string): Promise<void> {
    await runInTenant(tenant.ctx, (tx) =>
      tx.insert(invoices).values({
        tenantId: tenant.ctx.slug,
        invoiceId,
        memberId,
        planYear: 2026,
        planId,
        draftByUserId: admin.userId,
        status: 'issued',
        dueDate: '2026-12-31',
        pdfDocKind: 'invoice',
        fiscalYear: 2026,
        sequenceNumber: 1,
        documentNumber: 'ERAS-2026-000001',
        issueDate: '2026-01-01',
        currency: 'THB',
        subtotalSatang: 100000n,
        vatRateSnapshot: '0.0700',
        vatSatang: 7000n,
        totalSatang: 107000n,
        creditedTotalSatang: 0n,
        proRatePolicySnapshot: 'none',
        netDaysSnapshot: 30,
        tenantIdentitySnapshot: SNAP_TENANT,
        memberIdentitySnapshot: SNAP_MEMBER,
        pdfBlobKey: `invoicing/erase-test/${invoiceId}.pdf`,
        pdfSha256: 'a'.repeat(64),
        pdfTemplateVersion: 1,
      }),
    );
  }

  function buildDeps(): EraseMemberDeps {
    return {
      tenant: tenant.ctx,
      memberRepo: drizzleMemberRepo,
      contactRepo: drizzleContactRepo,
      invitations: drizzleInvitationCascadePort,
      sessions: authSessionRevocationPort,
      broadcastsCascade: noopBroadcastsCascadeAdapter,
      renewalsCascade: noopRenewalsCascadeAdapter,
      broadcastsContentScrub: noopBroadcastsContentScrubAdapter,
      broadcastsDeliveryTombstone: noopBroadcastsDeliveryTombstoneAdapter,
      userErasure: authUserErasureAdapter,
      tokens: emailChangeTokenAdapter,
      userEmails: userEmailAdapter,
      outboxCancel: outboxCancelAdapter,
      eventRegistrationErasure: noopEventRegistrationErasureAdapter,
      directoryErasure: noopDirectoryErasureAdapter,
      // The system under test.
      invoicingErasure: invoicingErasureAdapter,
      broadcastsAudienceDerivation: noopBroadcastsAudienceDerivationAdapter,
      subprocessorErasure: noopSubprocessorErasureAdapter,
      audit: drizzleAuditAdapter,
      clock: { now: () => new Date() },
    };
  }

  beforeAll(async () => {
    tenant = await createTestTenant();
    admin = await createActiveTestUser('admin');
    META.actorUserId = admin.userId;
    await runInTenant(tenant.ctx, (tx) =>
      seedF8MembershipPlan(tx, {
        tenantSlug: tenant.ctx.slug,
        planId,
        planName: { en: 'Erase Invoicing Plan' },
        benefitMatrix: DEFAULT_TEST_BENEFIT_MATRIX,
        createdBy: admin.userId,
      }),
    );

    await seedMember(erasedMemberId, 'Erase Co');
    await seedMember(peerMemberId, 'Peer Co');

    await seedDraft(draftInvoiceId, erasedMemberId);
    await seedDraft(secondDraftInvoiceId, erasedMemberId);
    await seedAutoRenewalDraft();
    await seedIssued(issuedInvoiceId, erasedMemberId);
    await seedDraft(peerDraftInvoiceId, peerMemberId);
  }, 60_000);

  afterAll(async () => {
    // `tenant.cleanup` may not cover invoices — remove them explicitly first.
    await db
      .delete(invoices)
      .where(
        and(
          eq(invoices.tenantId, tenant.ctx.slug),
          inArray(invoices.invoiceId, [
            draftInvoiceId,
            secondDraftInvoiceId,
            autoDraftInvoiceId,
            issuedInvoiceId,
            peerDraftInvoiceId,
          ]),
        ),
      );
    await db
      .delete(renewalCycles)
      .where(
        and(
          eq(renewalCycles.tenantId, tenant.ctx.slug),
          eq(renewalCycles.cycleId, autoCycleId),
        ),
      );
    await tenant.cleanup();
    await deleteTestUser(admin);
  }, 60_000);

  it('discards the erased member’s drafts and RETAINS the issued tax document', async () => {
    // Positive control: prove the fixture is real before asserting on it. A
    // green assertion over a fixture that never landed is the classic vacuous
    // pass, and this branch has already produced seven of those.
    const before = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.memberId, erasedMemberId)),
    );
    expect(
      before.map((r) => r.invoiceId).sort(),
      'fixture did not land — the assertions below would be vacuous',
    ).toEqual(
      [
        draftInvoiceId,
        secondDraftInvoiceId,
        autoDraftInvoiceId,
        issuedInvoiceId,
      ].sort(),
    );

    const res = await eraseMember(
      asMemberId(erasedMemberId),
      { reason: 'gdpr_erasure_request' },
      META,
      buildDeps(),
    );
    expect(res.ok).toBe(true);

    const after = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.memberId, erasedMemberId)),
    );

    // ALL THREE drafts gone — including the auto-renewal-shaped one, which is
    // the shape this feature actually produces; the issued document survives,
    // still `issued`.
    expect(after).toHaveLength(1);
    expect(after[0]?.invoiceId).toBe(issuedInvoiceId);
    expect(after[0]?.status).toBe('issued');
    expect(after.map((r) => r.invoiceId)).not.toContain(autoDraftInvoiceId);

    // The cycle's back-reference is left dangling by design (no FK; the issue
    // path tolerates a stale stamp) — assert that rather than leave it unstated.
    const cycle = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ stamp: renewalCycles.autoDraftInvoiceId })
        .from(renewalCycles)
        .where(eq(renewalCycles.cycleId, autoCycleId)),
    );
    expect(cycle[0]?.stamp).toBe(autoDraftInvoiceId);
  }, 60_000);

  it('leaves a PEER member’s draft untouched (member-scoped, not tenant-wide)', async () => {
    const peer = await runInTenant(tenant.ctx, (tx) =>
      tx
        .select({ invoiceId: invoices.invoiceId, status: invoices.status })
        .from(invoices)
        .where(eq(invoices.memberId, peerMemberId)),
    );
    expect(peer).toHaveLength(1);
    expect(peer[0]?.invoiceId).toBe(peerDraftInvoiceId);
    expect(peer[0]?.status).toBe('draft');
  }, 60_000);

  it('records an invoice_draft_deleted audit row per discarded draft', async () => {
    // Erasure is a compliance path — a silent discard is not acceptable. F4's
    // per-document event names WHICH invoice was removed.
    const rows = await db
      .select({ payload: auditLog.payload })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenantId, tenant.ctx.slug),
          eq(auditLog.eventType, 'invoice_draft_deleted'),
        ),
      );
    const deletedIds = rows.map(
      (r) => (r.payload as { invoice_id?: string } | null)?.invoice_id,
    );
    expect(deletedIds).toContain(draftInvoiceId);
    expect(deletedIds).toContain(secondDraftInvoiceId);
    // The retained tax document must never appear in a deletion trail.
    expect(deletedIds).not.toContain(issuedInvoiceId);
  }, 60_000);
});
