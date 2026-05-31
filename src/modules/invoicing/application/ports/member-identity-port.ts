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
   * The member's plan `memberTypeScope` (S1-P1-16). `'company'` members MUST
   * carry a tax_id to be issued a Thai tax invoice (FR-009a / Revenue Code §86);
   * person tiers (`'individual'`) and mixed `'both'`-scope plans are exempt.
   * `null` when the plan row is missing (defensive — treated as not-a-company so
   * issue is never blocked on a data gap). The gate fires ONLY on an explicit
   * `'company'` scope, so `'both'`/`'individual'`/`null` all fail open.
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
