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
