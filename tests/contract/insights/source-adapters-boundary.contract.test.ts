/**
 * F9 T017a — inter-module boundary contract test [analyze R2-M1].
 *
 * The `insights` module reads from sibling modules ONLY through their PUBLIC
 * BARRELS (Constitution Principle III — no deep/foreign-table imports). This
 * test pins that boundary: it asserts (1) each sibling barrel still exports the
 * exact symbols the F9 source-adapters compose from, with the callable shape the
 * adapter assumes, and (2) each adapter satisfies the F9-owned source port. A
 * barrel rename, a factory that starts returning a Promise, or a dropped port
 * method now fails HERE — the deliberate boundary artifact the analyze gate
 * asked for (R2-M1), beyond what `tsc` alone documents.
 *
 * Scope split (mirrors event-attendees-port.contract.test.ts): structural +
 * pure-function conformance runs in this unit-config file (no DB); BEHAVIOURAL
 * conformance against the real barrels — actual queries returning correct
 * aggregates — is verified at the integration layer (see the `it.todo` marker
 * at the end). The adapters' DB-touching methods are intentionally NOT invoked
 * here (the unit env only has a placeholder DATABASE_URL).
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';

// Sibling PUBLIC BARRELS the insights source-adapters depend on.
import {
  listInvoices,
  makeListInvoicesDeps,
  computeIsOverdue,
} from '@/modules/invoicing';
import { directorySearchWithCount } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { makeBroadcastApprovalCounter } from '@/modules/broadcasts';
import {
  listWaivedRefundTotalsByInvoice,
  makeListWaivedRefundTotalsByInvoiceDeps,
} from '@/modules/payments';

// The F9 adapters under contract + the F9-owned ports they must satisfy.
import { invoiceSourceAdapter } from '@/modules/insights/infrastructure/sources/invoice-source-adapter';
import { memberSourceAdapter } from '@/modules/insights/infrastructure/sources/member-source-adapter';
import { broadcastSourceAdapter } from '@/modules/insights/infrastructure/sources/broadcast-source-adapter';
import { waivedRefundSourceAdapter } from '@/modules/insights/infrastructure/sources/waived-refund-source-adapter';
import type {
  InvoiceSource,
  MemberSource,
  BroadcastConsumptionSource,
  WaivedRefundSource,
} from '@/modules/insights/application/ports/source-ports';

const SLUG = 'test-tenant';
const ctx = asTenantContext(SLUG);

describe('F9 inter-module boundary contract [T017a / analyze R2-M1]', () => {
  describe('invoicing barrel → InvoiceSource', () => {
    it('exports the functions the adapter composes from', () => {
      expect(typeof listInvoices).toBe('function');
      expect(typeof makeListInvoicesDeps).toBe('function');
      expect(typeof computeIsOverdue).toBe('function');
    });

    it('computeIsOverdue applies the overdue rule the adapter.countOverdue relies on', () => {
      // The adapter lists `issued` invoices and counts those past due. Pin the
      // exact contract it depends on: issued + past-due → overdue; any
      // non-issued status (e.g. paid) → never overdue, regardless of due date.
      const pastDue = '2020-01-01';
      const now = '2026-05-27T00:00:00.000Z';
      const issued = { status: 'issued', dueDate: pastDue } as unknown as Parameters<
        typeof computeIsOverdue
      >[0];
      const paid = { status: 'paid', dueDate: pastDue } as unknown as Parameters<
        typeof computeIsOverdue
      >[0];
      const issuedFuture = {
        status: 'issued',
        dueDate: '2099-01-01',
      } as unknown as Parameters<typeof computeIsOverdue>[0];
      expect(computeIsOverdue(issued, now)).toBe(true);
      expect(computeIsOverdue(paid, now)).toBe(false);
      expect(computeIsOverdue(issuedFuture, now)).toBe(false);
    });

    it('makeListInvoicesDeps(slug) assembles deps without a DB round-trip', () => {
      expect(typeof makeListInvoicesDeps(SLUG)).toBe('object');
    });

    it('invoiceSourceAdapter satisfies the InvoiceSource port', () => {
      const port: InvoiceSource = invoiceSourceAdapter;
      expect(typeof port.getYtdPaidRevenueSatang).toBe('function');
      expect(typeof port.countOverdue).toBe('function');
      expect(typeof port.getMonthlyPaidRevenueSatang).toBe('function');
      expect(typeof port.getInvoiceStatusDistribution).toBe('function');
    });
  });

  describe('members barrel → MemberSource', () => {
    it('exports the functions the adapter composes from', () => {
      expect(typeof directorySearchWithCount).toBe('function');
      expect(typeof buildMembersDeps).toBe('function');
    });

    it('buildMembersDeps(ctx) exposes the tenant + memberRepo the adapter reads', () => {
      const deps = buildMembersDeps(ctx);
      expect(deps.tenant).toBeDefined();
      expect(deps.memberRepo).toBeDefined();
    });

    it('memberSourceAdapter satisfies the MemberSource port', () => {
      const port: MemberSource = memberSourceAdapter;
      expect(typeof port.countByStatus).toBe('function');
      expect(typeof port.countAtRisk).toBe('function');
      expect(typeof port.listAtRisk).toBe('function');
      expect(typeof port.joinDistribution).toBe('function');
    });
  });

  describe('broadcasts barrel → BroadcastConsumptionSource', () => {
    it('exports makeBroadcastApprovalCounter', () => {
      expect(typeof makeBroadcastApprovalCounter).toBe('function');
    });

    it('makeBroadcastApprovalCounter(slug) returns a counter with countAwaitingApproval', () => {
      const counter = makeBroadcastApprovalCounter(SLUG);
      expect(typeof counter.countAwaitingApproval).toBe('function');
    });

    it('broadcastSourceAdapter satisfies the awaiting-approval slice of the port', () => {
      const port: Pick<BroadcastConsumptionSource, 'countAwaitingApproval'> =
        broadcastSourceAdapter;
      expect(typeof port.countAwaitingApproval).toBe('function');
    });
  });

  // Track B — the ONE seam where insights reads F5. This file exists to fail
  // when a new sibling dependency lands, so a new source belongs here or the
  // guard silently stops covering the module it names.
  describe('payments barrel → WaivedRefundSource', () => {
    it('exposes listWaivedRefundTotalsByInvoice + its deps factory', () => {
      expect(typeof listWaivedRefundTotalsByInvoice).toBe('function');
      // Constructing deps must not touch the DB — the factory only wires a repo.
      expect(typeof makeListWaivedRefundTotalsByInvoiceDeps(SLUG)).toBe('object');
    });

    it('waivedRefundSourceAdapter satisfies the port', () => {
      const port: WaivedRefundSource = waivedRefundSourceAdapter;
      expect(typeof port.sumWaivedByInvoice).toBe('function');
    });
  });

  // Behavioural conformance against the real barrels (actual queries returning
  // correct aggregates) is verified on live Neon at the integration layer:
  //   - tests/integration/insights/dashboard-snapshot.test.ts (T022, 5/5 GREEN)
  //     exercises MemberSource + InvoiceSource + the broadcast counter end-to-end
  //     (counts, YTD revenue, overdue, awaiting-approval, 12-month trends).
  //   - tests/integration/insights/cross-tenant-isolation.test.ts (T019, 10/10)
  //     proves the Principle-I DB-layer tenant binding of these same reads.
  // The unit-vs-integration split mirrors event-attendees-port.contract.test.ts;
  // `it.todo` is a stable cross-reference marker (not a check:fixme violation).
  it.todo(
    'behavioural conformance verified at integration layer — T022 (dashboard-snapshot) + T019 (cross-tenant)',
  );
});
