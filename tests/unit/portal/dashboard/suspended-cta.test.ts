// tests/unit/portal/dashboard/suspended-cta.test.ts
//
// 059-membership-suspension Task 9 — smart-CTA target helper. Branches on
// whether an unpaid MEMBERSHIP invoice exists (found via the same
// `OutstandingInvoiceInput` data the Outstanding-balance card already loads)
// and asserts every produced target is reachable under the suspended
// allow-by-default denylist (`isSuspendedDeniedRoute`) — a target that is
// itself blocked would be a dead-end CTA (design doc § "Smart CTA — must
// never dead-end").
import { describe, expect, it } from 'vitest';
import {
  findUnpaidMembershipInvoiceId,
  resolveSuspendedCtaTarget,
} from '@/app/(member)/portal/_lib/suspended-cta';
import type { OutstandingInvoiceInput } from '@/app/(member)/portal/_lib/dashboard-stats';
import { isSuspendedDeniedRoute } from '@/lib/lapsed-portal-scope';

function invoice(overrides: Partial<OutstandingInvoiceInput>): OutstandingInvoiceInput {
  return {
    status: 'issued',
    totalSatang: 100_00n,
    dueDate: '2026-06-30',
    id: 'inv-1',
    invoiceSubject: 'membership',
    ...overrides,
  };
}

describe('findUnpaidMembershipInvoiceId', () => {
  it('returns null for an empty list', () => {
    expect(findUnpaidMembershipInvoiceId([])).toBeNull();
  });

  it('returns null when only event invoices are present', () => {
    expect(
      findUnpaidMembershipInvoiceId([invoice({ id: 'evt-1', invoiceSubject: 'event' })]),
    ).toBeNull();
  });

  it('ignores non-issued statuses even when the subject is membership', () => {
    expect(
      findUnpaidMembershipInvoiceId([
        invoice({ id: 'paid-1', status: 'paid' }),
        invoice({ id: 'void-1', status: 'void' }),
        invoice({ id: 'draft-1', status: 'draft' }),
      ]),
    ).toBeNull();
  });

  it('returns the single unpaid membership invoice id', () => {
    expect(
      findUnpaidMembershipInvoiceId([
        invoice({ id: 'evt-1', invoiceSubject: 'event' }),
        invoice({ id: 'mem-1', invoiceSubject: 'membership' }),
      ]),
    ).toBe('mem-1');
  });

  it('picks the membership invoice with the earliest due date when several exist', () => {
    expect(
      findUnpaidMembershipInvoiceId([
        invoice({ id: 'mem-late', dueDate: '2026-08-01' }),
        invoice({ id: 'mem-early', dueDate: '2026-06-01' }),
      ]),
    ).toBe('mem-early');
  });
});

describe('resolveSuspendedCtaTarget', () => {
  const memberId = 'a3f6e2d0-1111-4222-8333-444455556666';

  it('returns null (no CTA) for pending_review — the member already paid', () => {
    expect(
      resolveSuspendedCtaTarget({
        reason: 'pending_review',
        unpaidMembershipInvoiceId: 'mem-1',
        memberId,
      }),
    ).toBeNull();
  });

  it('returns null (no CTA) for pending_review even with no invoice on file', () => {
    expect(
      resolveSuspendedCtaTarget({
        reason: 'pending_review',
        unpaidMembershipInvoiceId: null,
        memberId,
      }),
    ).toBeNull();
  });

  it('links to the invoice when an unpaid membership invoice exists', () => {
    const target = resolveSuspendedCtaTarget({
      reason: 'unpaid',
      unpaidMembershipInvoiceId: 'mem-1',
      memberId,
    });
    expect(target).toEqual({ kind: 'pay_invoice', href: '/portal/invoices/mem-1' });
  });

  it('falls back to the self-serve renewal flow when no invoice is on file yet', () => {
    const target = resolveSuspendedCtaTarget({
      reason: 'unpaid',
      unpaidMembershipInvoiceId: null,
      memberId,
    });
    expect(target).toEqual({ kind: 'renew', href: `/portal/renewal/${memberId}` });
  });

  it.each([
    { reason: 'unpaid' as const, unpaidMembershipInvoiceId: 'mem-1' as string | null },
    { reason: 'unpaid' as const, unpaidMembershipInvoiceId: null as string | null },
  ])(
    'invariant: every produced target is reachable under the suspended denylist ($reason, invoiceId=$unpaidMembershipInvoiceId)',
    ({ reason, unpaidMembershipInvoiceId }) => {
      const target = resolveSuspendedCtaTarget({ reason, unpaidMembershipInvoiceId, memberId });
      expect(target).not.toBeNull();
      // A stripped-query pathname is what the denylist matches against.
      expect(isSuspendedDeniedRoute(target!.href)).toBe(false);
    },
  );
});
