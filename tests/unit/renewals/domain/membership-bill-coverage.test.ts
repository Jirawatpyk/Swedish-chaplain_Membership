import { describe, expect, it } from 'vitest';
import {
  findOverlappingMembershipCoverageBill,
  type InvoiceStatusLiteral,
  type MembershipBillCoverageRow,
} from '@/modules/renewals/domain/membership-bill-coverage';

/** A bill covering the 2026 term by default; override per case. */
function bill(
  o: Partial<MembershipBillCoverageRow> & { invoiceId: string; status: InvoiceStatusLiteral },
): MembershipBillCoverageRow {
  return { coverage: { from: '2026-01-01', to: '2027-01-01' }, ...o };
}

// A target window that OVERLAPS [2026-01-01, 2027-01-01).
const W = { from: '2026-06-01', to: '2027-06-01' };

describe('findOverlappingMembershipCoverageBill', () => {
  it('returns a committed (issued) bill whose coverage overlaps the target', () => {
    const hit = findOverlappingMembershipCoverageBill([bill({ invoiceId: 'a', status: 'issued' })], W);
    expect(hit?.invoiceId).toBe('a');
  });

  it('paid and partially_credited also block', () => {
    expect(findOverlappingMembershipCoverageBill([bill({ invoiceId: 'p', status: 'paid' })], W)).not.toBeNull();
    expect(
      findOverlappingMembershipCoverageBill([bill({ invoiceId: 'pc', status: 'partially_credited' })], W),
    ).not.toBeNull();
  });

  it('void and fully-credited never block — the period is re-billable', () => {
    expect(findOverlappingMembershipCoverageBill([bill({ invoiceId: 'v', status: 'void' })], W)).toBeNull();
    expect(findOverlappingMembershipCoverageBill([bill({ invoiceId: 'c', status: 'credited' })], W)).toBeNull();
  });

  it('a draft does NOT block by default, but DOES when includeDrafts is set', () => {
    const drafts = [bill({ invoiceId: 'd', status: 'draft' })];
    expect(findOverlappingMembershipCoverageBill(drafts, W)).toBeNull();
    expect(
      findOverlappingMembershipCoverageBill(drafts, W, { includeDrafts: true })?.invoiceId,
    ).toBe('d');
  });

  it('a NULL coverage window never participates (legacy / first-payment / orphan)', () => {
    const noCoverage = [bill({ invoiceId: 'n', status: 'issued', coverage: null })];
    expect(findOverlappingMembershipCoverageBill(noCoverage, W)).toBeNull();
    // includeDrafts does not change the NULL-coverage exclusion for a draft either.
    const draftNoCoverage = [bill({ invoiceId: 'dn', status: 'draft', coverage: null })];
    expect(findOverlappingMembershipCoverageBill(draftNoCoverage, W, { includeDrafts: true })).toBeNull();
  });

  it('adjacent terms do NOT overlap — target starts at the bill\'s end (half-open [from, to))', () => {
    // bill covers [2026-01-01, 2027-01-01); target starts exactly at 2027-01-01.
    const adjacent = findOverlappingMembershipCoverageBill([bill({ invoiceId: 'adj', status: 'issued' })], {
      from: '2027-01-01',
      to: '2028-01-01',
    });
    expect(adjacent).toBeNull();
  });

  it('adjacent terms do NOT overlap — bill starts at the target\'s end (reverse adjacency)', () => {
    // target W = [2026-06-01, 2027-06-01); bill covers [2027-06-01, 2028-06-01),
    // starting exactly at W's end. billFrom < newTo is false → no overlap.
    const adjacent = findOverlappingMembershipCoverageBill(
      [bill({ invoiceId: 'radj', status: 'issued', coverage: { from: '2027-06-01', to: '2028-06-01' } })],
      W,
    );
    expect(adjacent).toBeNull();
  });

  it('a bill fully CONTAINED inside the target window overlaps', () => {
    const inner = [bill({ invoiceId: 'inner', status: 'issued', coverage: { from: '2026-08-01', to: '2026-09-01' } })];
    expect(findOverlappingMembershipCoverageBill(inner, W)?.invoiceId).toBe('inner');
  });

  it('a bill that fully CONTAINS the target window overlaps', () => {
    const outer = [bill({ invoiceId: 'outer', status: 'issued', coverage: { from: '2020-01-01', to: '2030-01-01' } })];
    expect(findOverlappingMembershipCoverageBill(outer, W)?.invoiceId).toBe('outer');
  });

  it("excludeInvoiceId skips the caller's own bill", () => {
    expect(
      findOverlappingMembershipCoverageBill([bill({ invoiceId: 'self', status: 'issued' })], W, {
        excludeInvoiceId: 'self',
      }),
    ).toBeNull();
  });

  it('excludeInvoiceId skips only the named bill — a DIFFERENT overlapping bill still blocks', () => {
    const bills = [
      bill({ invoiceId: 'self', status: 'issued' }),
      bill({ invoiceId: 'other', status: 'paid' }),
    ];
    expect(
      findOverlappingMembershipCoverageBill(bills, W, { excludeInvoiceId: 'self' })?.invoiceId,
    ).toBe('other');
  });

  it('returns null when there are no candidate bills', () => {
    expect(findOverlappingMembershipCoverageBill([], W)).toBeNull();
  });

  it('returns the FIRST overlapping committed bill', () => {
    const bills = [
      bill({ invoiceId: 'skip', status: 'void' }),
      bill({ invoiceId: 'first', status: 'issued' }),
      bill({ invoiceId: 'second', status: 'paid' }),
    ];
    expect(findOverlappingMembershipCoverageBill(bills, W)?.invoiceId).toBe('first');
  });

  it('throws LOUD on a malformed target window rather than silently under-blocking', () => {
    expect(() =>
      findOverlappingMembershipCoverageBill([bill({ invoiceId: 'a', status: 'issued' })], {
        from: 'not-a-date',
        to: '2027-01-01',
      }),
    ).toThrow(/malformed coverage window/);
  });
});
