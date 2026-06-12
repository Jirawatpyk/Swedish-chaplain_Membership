/**
 * REMOVE-WITH-064-REMEDIATION (site 13 unit pin — master checklist at the
 * guard in record-payment.ts) — boundary tests for the extracted portal
 * pay-gate predicate `isLegacyNoTinEventInvoice`.
 *
 * 065 review follow-up [Sev 7]: the predicate's OVER-match arm previously
 * had no backstop — a drift that widened it (e.g. dropping the TIN check,
 * or matching 'paid'/'draft') would silently strip the Pay-now button from
 * every TIN event invoice while all server-side guards stayed green. These
 * tests pin BOTH arms:
 *
 *   - MATCH (true)  → legacy issued no-TIN event row loses Pay-now and gets
 *     the "under document correction" notice (S0 money-trap fence).
 *   - NO-MATCH (false) → everything else keeps its normal pay surface.
 *
 * Trim parity: `buyerHasTin` treats a whitespace-only `tax_id` as ABSENT
 * ((taxId ?? '').trim() !== '' — shared Domain helper), so the predicate
 * must match a `'   '` TIN exactly like the record-payment guard does.
 * The member-identity-snapshot zod schema (`.min(1).nullable()`) ACCEPTS a
 * whitespace-only tax_id, so this legacy data class is representable.
 */
import { describe, expect, it } from 'vitest';
import { isLegacyNoTinEventInvoice } from '@/app/(member)/portal/invoices/_utils/legacy-no-tin';
import {
  makeMemberIdentitySnapshot,
  type MemberIdentitySnapshot,
} from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import type { Invoice } from '@/modules/invoicing';

function snapshot(taxId: string | null): MemberIdentitySnapshot {
  return makeMemberIdentitySnapshot({
    legal_name: 'Test Buyer Co., Ltd.',
    tax_id: taxId,
    address: '1 Test Road, Bangkok 10110',
    primary_contact_name: 'Contact Person',
    primary_contact_email: 'contact@example.com',
  });
}

/** Structural subset accepted by the predicate — no full Invoice fixture needed. */
function subject(
  invoiceSubject: Invoice['invoiceSubject'],
  status: Invoice['status'],
  memberIdentitySnapshot: MemberIdentitySnapshot | null,
): Pick<Invoice, 'invoiceSubject' | 'status' | 'memberIdentitySnapshot'> {
  return { invoiceSubject, status, memberIdentitySnapshot };
}

describe('isLegacyNoTinEventInvoice — portal pay-gate predicate (064 interim guard, site 13)', () => {
  it('matches an issued EVENT invoice whose buyer has NO TIN (the legacy §105 row)', () => {
    expect(isLegacyNoTinEventInvoice(subject('event', 'issued', snapshot(null)))).toBe(true);
  });

  it('does NOT match an issued EVENT invoice whose buyer HAS a TIN (Pay-now must stay)', () => {
    expect(
      isLegacyNoTinEventInvoice(subject('event', 'issued', snapshot('0105556012345'))),
    ).toBe(false);
  });

  it('matches a whitespace-only TIN exactly like the record-payment guard (trim parity)', () => {
    expect(isLegacyNoTinEventInvoice(subject('event', 'issued', snapshot('   ')))).toBe(true);
  });

  it('does NOT match a MEMBERSHIP invoice, even issued with no TIN', () => {
    expect(isLegacyNoTinEventInvoice(subject('membership', 'issued', snapshot(null)))).toBe(
      false,
    );
  });

  it('does NOT match an event DRAFT (drafts have no member-facing pay surface)', () => {
    expect(isLegacyNoTinEventInvoice(subject('event', 'draft', snapshot(null)))).toBe(false);
  });

  it('does NOT match a PAID event invoice (nothing left to pay — no gate needed)', () => {
    expect(isLegacyNoTinEventInvoice(subject('event', 'paid', snapshot(null)))).toBe(false);
  });

  it('fails CLOSED on a NULL buyer snapshot (issued event row with unverifiable buyer)', () => {
    // Mirrors the page's former `invoice.memberIdentitySnapshot?.tax_id`
    // optional chaining: an anomalous issued event row with no snapshot must
    // never surface Pay-now (treated as no-TIN, not as payable).
    expect(isLegacyNoTinEventInvoice(subject('event', 'issued', null))).toBe(true);
  });
});
