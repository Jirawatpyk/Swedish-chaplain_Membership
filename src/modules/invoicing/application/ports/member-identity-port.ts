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
}
