/**
 * 016 PR 3 — client-mirror role gate on the command-palette RESULTS payload.
 *
 * The palette has TWO client-side role filters, and they are not the same code:
 *
 *   1. `filterEntriesByRole` (registry.ts) — gates the static action/navigate
 *      REGISTRY entries. T031 routed it through the D16 totaliser.
 *   2. the filter applied to the SEARCH RESPONSE (`results`) inside
 *      `command-palette.tsx` — a defence-in-depth mirror of the server's
 *      `search-plans.ts → filterByRole`. **T031 did not touch it**, so it kept
 *      comparing `currentUserRole === 'admin'` literally.
 *
 * That second filter is the bug this file pins. After Migration C promotes every
 * human admin to `super_admin`, the raw comparison falls through to the else
 * branch and returns `actions: []` + `refundableInvoices: []` — the server sends
 * the full payload (it normalises correctly) and the client silently drops the
 * entire Actions group for every human operator: New plan, New member, New
 * invoice, Record payment, Issue refund, Review broadcasts, View audit log…
 *
 * Same shape as the C1 affordance class, third occurrence: a LOCAL COPY of a
 * role predicate that a union-widening sweep cannot see.
 *
 * D16 totalisation is the contract: super_admin → admin semantics, marketing and
 * unknown → the empty set (never escalate).
 */
import { describe, expect, it } from 'vitest';
import {
  filterResultsByRole,
  type PaletteSearchResponse,
} from '@/components/command-palette/registry';

/** A full payload: one entry in every group, actions split admin-only vs read. */
const RESULTS: PaletteSearchResponse['results'] = {
  plans: [{ id: 'p1', year: 2026, name: 'Platinum', tier: 'platinum', status: 'active' }],
  members: [{ id: 'm1', displayName: 'Acme Co', memberNumber: 1, status: 'active' }],
  refundableInvoices: [
    { id: 'i1', invoiceNumber: 'INV-1', memberDisplayName: 'Acme Co', totalSatang: 1000 },
  ],
  actions: [
    // admin-only (ADMIN_ONLY_ACTION_IDS)
    { id: 'plan.new', label: 'palette.actions.newPlan', url: '/admin/plans/new' },
    // read-tier (manager may see it)
    { id: 'audit.view', label: 'palette.actions.viewAuditLog', url: '/admin/audit' },
  ],
  navigate: [{ id: 'nav.plans', label: 'palette.navigate.plansList', url: '/admin/plans' }],
} as unknown as PaletteSearchResponse['results'];

describe('filterResultsByRole — palette client mirror (D16)', () => {
  it('admin keeps the full payload', () => {
    expect(filterResultsByRole(RESULTS, 'admin')).toEqual(RESULTS);
  });

  it('super_admin keeps the full payload (D16: admin semantics)', () => {
    // THE REGRESSION: a raw `role === 'admin'` comparison returns actions: []
    // and refundableInvoices: [] here, emptying the palette's Actions group for
    // every human operator after Migration C.
    const out = filterResultsByRole(RESULTS, 'super_admin');
    expect(out.actions).toHaveLength(2);
    expect(out.actions.map((a) => a.id)).toContain('plan.new');
    expect(out.refundableInvoices).toHaveLength(1);
    expect(out.navigate).toHaveLength(1);
    expect(out.plans).toHaveLength(1);
    expect(out.members).toHaveLength(1);
  });

  it('manager loses admin-only actions + refundable invoices, keeps read entries', () => {
    const out = filterResultsByRole(RESULTS, 'manager');
    expect(out.refundableInvoices).toEqual([]);
    expect(out.actions.map((a) => a.id)).toEqual(['audit.view']);
    expect(out.navigate).toHaveLength(1);
    expect(out.plans).toHaveLength(1);
    expect(out.members).toHaveLength(1);
  });

  it('marketing gets no actions, no refundable invoices and no navigate (D16 deny, never escalate)', () => {
    const out = filterResultsByRole(RESULTS, 'marketing');
    expect(out.actions).toEqual([]);
    expect(out.refundableInvoices).toEqual([]);
    expect(out.navigate).toEqual([]);
  });

  it('member gets no navigate entries', () => {
    const out = filterResultsByRole(RESULTS, 'member');
    expect(out.navigate).toEqual([]);
    expect(out.actions).toEqual([]);
    expect(out.refundableInvoices).toEqual([]);
  });

  it('an unknown role never escalates', () => {
    const out = filterResultsByRole(RESULTS, 'not-a-role' as never);
    expect(out.actions).toEqual([]);
    expect(out.refundableInvoices).toEqual([]);
    expect(out.navigate).toEqual([]);
  });
});
