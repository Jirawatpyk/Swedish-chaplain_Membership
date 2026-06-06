/**
 * T083 — F3 × F4 timeline integration (US7).
 *
 * Contract: the 6 F4 audit event types listed in
 * `F4_MEMBER_TIMELINE_EVENT_TYPES` (the barrel-exported enumeration)
 * MUST surface in the F3 per-member timeline with:
 *   - correct `eventType`
 *   - actor preserved
 *   - payload available to the copy resolver
 *   - chronological ordering alongside existing F3 events
 *
 * Strategy: seed synthetic audit rows (same technique as US6
 * `timeline.test.ts`) so the contract is verified independently of
 * whether every F4 use-case is wired yet (invoice_voided =
 * Phase 9 / US5, invoice_pdf_resent = Phase 10 / T107).
 *
 * This test also exercises the copy resolver (`resolveInvoiceEventCopy`)
 * so the full US7 rendering pipeline is integration-tested.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { db, runInTenant } from '@/lib/db';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { membershipPlans } from '@/modules/plans/infrastructure/db/schema';
import type { BenefitMatrix } from '@/modules/plans/domain/benefit-matrix';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  F4_MEMBER_TIMELINE_EVENT_TYPES,
  type F4MemberTimelineEventType,
} from '@/modules/invoicing';
import { resolveInvoiceEventCopy } from '@/modules/members/application/timeline/resolve-invoice-event-copy';
import { createTestTenant, type TestTenant } from '../helpers/test-tenant';
import {
  createActiveTestUser,
  type TestUser,
} from '../helpers/test-users';
import { nextSeedMemberNumber } from '../helpers/seed-member-number';

const MATRIX: BenefitMatrix = {
  eblast_per_year: 1,
  website_page_type: 'member_news_update',
  homepage_logo_category: 'regular',
  directory_listing_size: 'half_page',
  event_discount_scope: 'all_employees',
  events_cobranded_access: false,
  cultural_tickets_per_year: 0,
  m2m_benefits_access: true,
  business_referrals: true,
  tailor_made_services: false,
  partnership: null,
};

/** Audit payload shapes mirror the real F4 emit sites. */
function payloadFor(
  eventType: F4MemberTimelineEventType,
  memberId: string,
  invoiceId: string,
  creditNoteId: string,
): Record<string, unknown> {
  switch (eventType) {
    case 'invoice_draft_created':
      return {
        invoice_id: invoiceId,
        member_id: memberId,
        plan_id: 'p',
        plan_year: 2026,
      };
    case 'invoice_issued':
      // Mixed type on purpose: DB jsonb preserves the number-vs-string
      // distinction, and the copy resolver must coerce either shape.
      // Unit tests cover the resolver in isolation; integration test
      // proves the coercion survives the DB round-trip.
      return {
        invoice_id: invoiceId,
        member_id: memberId,
        document_number: 'INV-2026-0042',
        total_satang: 107000,
      };
    case 'invoice_paid':
      return {
        invoice_id: invoiceId,
        member_id: memberId,
        payment_method: 'bank_transfer',
        receipt_document_number: 'RCT-2026-0042',
      };
    case 'invoice_voided':
      return {
        invoice_id: invoiceId,
        member_id: memberId,
        reason: 'duplicate',
      };
    case 'credit_note_issued':
      return {
        credit_note_id: creditNoteId,
        original_invoice_id: invoiceId,
        member_id: memberId,
        credit_amount_satang: '10000',
        document_number: 'CN-2026-0001',
      };
    case 'invoice_pdf_resent':
      return {
        invoice_id: invoiceId,
        member_id: memberId,
        document_number: 'INV-2026-0042',
      };
  }
}

describe('F3 × F4 timeline integration (T083, US7)', () => {
  let tenant: TestTenant;
  let user: TestUser;
  let memberId: string;
  const invoiceId = randomUUID();
  const creditNoteId = randomUUID();

  beforeAll(async () => {
    user = await createActiveTestUser('admin');
    tenant = await createTestTenant('test-swecham');
    memberId = randomUUID();

    await runInTenant(tenant.ctx, async (tx) => {
      await tx.insert(membershipPlans).values({
        tenantId: tenant.ctx.slug,
        planId: 'us7-plan',
        planYear: 2026,
        planName: { en: 'US7 Plan' },
        description: { en: 'Test description' },
        sortOrder: 10,
        planCategory: 'corporate',
        memberTypeScope: 'company',
        annualFeeMinorUnits: 1_000_000,
        includesCorporatePlanId: null,
        minTurnoverMinorUnits: null,
        maxTurnoverMinorUnits: null,
        maxDurationYears: null,
        maxMemberAge: null,
        benefitMatrix: MATRIX,
        isActive: true,
        createdBy: user.userId,
        updatedBy: user.userId,
      });
      await tx.insert(members).values({
        tenantId: tenant.ctx.slug,
        memberId,
        memberNumber: nextSeedMemberNumber(),
        companyName: 'US7 Co',
        country: 'TH',
        planId: 'us7-plan',
        planYear: 2026,
      });
    });

    // Seed one audit row per F4 timeline event type, spaced 1s apart
    // so chronological ordering is deterministic.
    const baseTs = Date.now() - F4_MEMBER_TIMELINE_EVENT_TYPES.length * 1000;
    for (let i = 0; i < F4_MEMBER_TIMELINE_EVENT_TYPES.length; i++) {
      const eventType = F4_MEMBER_TIMELINE_EVENT_TYPES[i]!;
      await db.insert(auditLog).values({
        tenantId: tenant.ctx.slug,
        eventType,
        actorUserId: user.userId,
        requestId: `us7-seed-${eventType}`,
        summary: `US7 seed ${eventType}`,
        payload: payloadFor(eventType, memberId, invoiceId, creditNoteId),
        timestamp: new Date(baseTs + i * 1000),
      });
    }
  }, 60_000);

  afterAll(async () => {
    await tenant.cleanup().catch(() => {});
  });

  it('timeline surfaces all 6 F4 member-timeline event types (AS2)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId, limit: 100 },
      { actorUserId: user.userId, actorRole: 'admin', requestId: 't-us7-1' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const seen = new Set(r.value.events.map((e) => e.eventType));
    for (const t of F4_MEMBER_TIMELINE_EVENT_TYPES) {
      expect(seen.has(t), `timeline missing F4 event '${t}'`).toBe(true);
    }
  });

  it('every F4 row preserves actor + payload shape for copy resolver', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId, limit: 100 },
      { actorUserId: user.userId, actorRole: 'admin', requestId: 't-us7-2' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    for (const t of F4_MEMBER_TIMELINE_EVENT_TYPES) {
      const row = r.value.events.find((e) => e.eventType === t);
      expect(row, `missing row for '${t}'`).toBeDefined();
      if (!row) continue;
      // F4 invoice timeline events are audit_log rows → the audit variant of
      // the discriminated union carries actorUserId (review-run I5).
      if (row.source !== 'audit') throw new Error(`expected '${t}' to be an audit-source row`);
      expect(row.actorUserId).toBe(user.userId);
      const copy = resolveInvoiceEventCopy(row.eventType, row.payload);
      expect(copy, `copy resolver returned null for '${t}'`).not.toBeNull();
      if (!copy) continue;

      // Every F4 timeline event produces a non-empty i18n key that
      // matches the `invoice*` / `creditNoteIssued` namespace.
      expect(copy.i18nKey).toMatch(/^(invoice|creditNote)/);

      // Per-event interpolation invariants — a missing `vars` key
      // would render the locale string with an empty `{placeholder}`
      // hole in production, silently degrading UX.
      if (t === 'invoice_issued') {
        expect(copy.vars.documentNumber).toBe('INV-2026-0042');
        expect(copy.vars.totalSatang).toBe('107000');
        expect(copy.link).toBe(`/admin/invoices/${invoiceId}`);
      }
      if (t === 'invoice_paid') {
        expect(copy.vars.paymentMethod).toBe('bank_transfer');
        expect(copy.vars.documentNumber).toBe('RCT-2026-0042');
      }
      if (t === 'invoice_voided') {
        expect(copy.vars.reason).toBe('duplicate');
      }
      if (t === 'credit_note_issued') {
        expect(copy.vars.documentNumber).toBe('CN-2026-0001');
        expect(copy.vars.creditAmountSatang).toBe('10000');
        // Credit-note events deep-link to the credit-note detail, not
        // the original invoice — required so admins land on the
        // correct document.
        expect(copy.link).toBe(`/admin/credit-notes/${creditNoteId}`);
      }
    }
  });

  it('SC-011 — F4 events surface in the member timeline within 5 s', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const start = Date.now();
    const r = await timelineList(
      { memberId, limit: 100 },
      {
        actorUserId: user.userId,
        actorRole: 'admin',
        requestId: 't-us7-sc011',
      },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    const elapsedMs = Date.now() - start;
    expect(r.ok).toBe(true);
    // SC-011: "100% of F4 state-change events appear in the F3 member
    // timeline within 5 seconds of the triggering action". We measure
    // the read-path latency here (the write-path is bounded by the
    // same runInTenant transaction that emitted the audit row, so the
    // write→read gap is effectively zero). Passing this assertion on
    // live Neon Singapore is a proxy for the end-to-end SLO.
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('F4 events are chronologically interleaved with F3 events (AS2)', async () => {
    const deps = buildMembersDeps(tenant.ctx);
    const r = await timelineList(
      { memberId, limit: 100 },
      { actorUserId: user.userId, actorRole: 'admin', requestId: 't-us7-3' },
      tenant.ctx,
      { memberRepo: deps.memberRepo, timeline: deps.timeline },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // Newest-first ordering held — the repo guarantees it, but this
    // assertion closes the loop for the mixed F3+F4 case.
    for (let i = 0; i < r.value.events.length - 1; i++) {
      expect(
        r.value.events[i]!.timestamp.getTime(),
      ).toBeGreaterThanOrEqual(r.value.events[i + 1]!.timestamp.getTime());
    }
  });

  it('F4 rows are not visible from a different tenant (RLS)', async () => {
    const otherTenant = await createTestTenant('test-swecham');
    try {
      const deps = buildMembersDeps(otherTenant.ctx);
      const r = await timelineList(
        { memberId, limit: 100 },
        {
          actorUserId: user.userId,
          actorRole: 'admin',
          requestId: 't-us7-4',
        },
        otherTenant.ctx,
        { memberRepo: deps.memberRepo, timeline: deps.timeline },
      );
      // Member doesn't exist in this tenant → not_found (or empty
      // events). Either way the F4 rows seeded on tenantA MUST NOT
      // leak across.
      if (r.ok) {
        // Belt-and-suspenders: RLS leaking via "empty rows but ok"
        // is still a leak of member-existence across tenants. Assert
        // both emptiness AND absence of F4 rows explicitly.
        expect(r.value.events.length).toBe(0);
        const f4Leaked = r.value.events.some((e) =>
          (F4_MEMBER_TIMELINE_EVENT_TYPES as readonly string[]).includes(
            e.eventType,
          ),
        );
        expect(f4Leaked).toBe(false);
      } else {
        expect(r.error.type).toBe('not_found');
      }
    } finally {
      await otherTenant.cleanup().catch(() => {});
    }
  }, 60_000);
});
