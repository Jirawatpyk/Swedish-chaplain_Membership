/**
 * T032 — Member identity port (F4).
 *
 * Reads from `@/modules/members` public barrel to build a
 * MemberIdentitySnapshot at issue time. Member archival status is
 * verified in the same call (FR-037 — refuse issue on archived member).
 */
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';

export interface MemberIdentityView {
  readonly memberId: string;
  readonly isActive: boolean;
  readonly isArchived: boolean;
  readonly snapshot: MemberIdentitySnapshot;
  /**
   * The member's plan `memberTypeScope` (S1-P1-16): `'company'` / `'individual'`
   * / `'both'`, or `null` when the plan row is missing.
   *
   * NOTE — informational only; issuance is NOT gated on this. The former
   * `tax_id_required` block (which refused a company tax invoice without a
   * 13-digit TIN) was REMOVED per the auditor ruling of 2026-06-12: a §86/4
   * membership tax invoice is issued regardless of whether the buyer carries a
   * TIN (the buyer TIN is mandatory only for a VAT-registrant buyer's own
   * input-VAT claim — the seller chamber is never at fault), so the PDF simply
   * omits the TIN line. See the doc-kind gate in `issue-invoice.ts` (whose only
   * issue-time TIN-presence gate is EVENT + no-TIN → §105 paid-issue path; a
   * separate `invalid_tax_id_format` *format* check and the §86/10 credit-note
   * rules are distinct guards, not company-scope issuance blocks). This field
   * is carried on the `MemberIdentityView` (a sibling of `snapshot`, not inside
   * the `MemberIdentitySnapshot` VO) for reference/observability but no
   * invoicing use-case reads it to block issuance.
   */
  readonly memberTypeScope: 'company' | 'individual' | 'both' | null;
  /**
   * ISO date string (YYYY-MM-DD) of when the member joined the chamber.
   * Used by the invoicing pro-rate policy to decide the correct factor
   * on the FIRST invoice of a cycle (US1 AS2).
   */
  readonly registrationDate: string;
  /**
   * Whether the tenant's one-off registration fee has already been paid.
   * When false, `create-invoice-draft` adds a second line item charging
   * `tenant_invoice_settings.registration_fee_satang` (US1 AS1).
   */
  readonly registrationFeePaid: boolean;
}

export interface MemberIdentityPort {
  /**
   * Read the member for issue-time snapshotting. Acquires a row lock
   * when `opts.forUpdate = true` — issue-invoice sets this to guarantee
   * archive-vs-issue races resolve cleanly (FR-037).
   */
  getForIssue(
    tx: unknown,
    tenantId: string,
    memberId: string,
    opts?: { readonly forUpdate?: boolean },
  ): Promise<MemberIdentityView | null>;

  /**
   * Flip `members.registration_fee_paid` to true. Called from
   * `record-payment` inside the same transaction as `applyPayment`
   * when the paid invoice contained a registration-fee line — so a
   * subsequent invoice for the same member won't charge the fee
   * again (spec § 398 "once per member lifecycle").
   *
   * Idempotent: running it when the column is already true is a
   * no-op (the UPDATE simply affects 0 rows).
   */
  markRegistrationFeePaid(
    tx: unknown,
    tenantId: string,
    memberId: string,
  ): Promise<void>;
}
