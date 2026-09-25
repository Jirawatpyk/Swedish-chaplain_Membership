/**
 * F119 T055 — `BroadcastVersionsRepo` Application port (data-model § 1).
 *
 * One row per version of an E-Blast's content: `version_no = 0` is the
 * member's original, materialised lazily when marketing first starts
 * formatting (research R2); `1..n` are marketing's formatted versions. At
 * most one working copy (`sent_to_member_at IS NULL`) exists per E-Blast —
 * the `broadcast_versions_one_unsent_idx` partial unique index — and a sent
 * version is read-only (`broadcast_versions_immutable_after_send_fn`).
 *
 * Deliberately small: ONE list read, from which the Application derives the
 * member's original, the latest sent version and the working copy (the
 * thread needs the whole list anyway), one insert, one working-copy update
 * and the send stamp (T059). No delete path (the parent's ON DELETE CASCADE is the only one),
 * and the erasure redaction is T082's, not this port's.
 *
 * Every method runs on the caller's `runInTenant` `tx` — REQUIRED, never
 * optional: an adapter that reached for the pool-global `db` would get a
 * connection with no `app.current_tenant` and silently bypass RLS + FORCE
 * (the F7.1a US2 rule).
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantSlug } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { BroadcastActorRole, BroadcastId, BroadcastVersionId } from '../../domain/broadcast';
import type { BroadcastVersion } from '../../domain/approval/broadcast-version';

/** Opaque tx handle from `BroadcastsRepo.withTx` (see `BrandSettingsTx`). */
export type BroadcastVersionsTx = unknown;

export interface NewBroadcastVersion {
  readonly broadcastId: BroadcastId;
  readonly versionNo: number;
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodySource: string;
  readonly noteToMember: string | null;
  readonly authoredByUserId: string;
  readonly authoredByRole: BroadcastActorRole;
  /** null ⇒ the working copy; set ⇒ read-only from the moment of insert. */
  readonly sentToMemberAt: Date | null;
}

export interface WorkingCopyWrite {
  readonly subject: string;
  readonly bodyHtml: string;
  readonly bodySource: string;
  readonly noteToMember: string | null;
  /** The new optimistic-concurrency token, written explicitly (ms precision). */
  readonly updatedAt: Date;
}

export interface BroadcastVersionsRepo {
  /** Every version of one E-Blast, ordered by `version_no` ascending. */
  listByBroadcast(
    tenantId: TenantSlug,
    broadcastId: BroadcastId,
    tx: BroadcastVersionsTx,
  ): Promise<readonly BroadcastVersion[]>;

  /**
   * F119 T083 — the member DSAR read (research R17): every version SENT to the
   * member (v0, the member's original, is stamped at materialisation, so it is
   * included) of every E-Blast the member originated, newest first, at most
   * `limit` rows (the caller passes cap + 1 to detect truncation). An unsent
   * working copy is marketing's work in progress and is never returned — the
   * same rule as the portal thread (FR-003's read side).
   */
  listSentByMember(
    tenantId: TenantSlug,
    memberId: MemberId,
    limit: number,
    tx: BroadcastVersionsTx,
  ): Promise<readonly BroadcastVersion[]>;

  /** Insert one version; returns it with its generated id and timestamps. */
  insert(
    tenantId: TenantSlug,
    input: NewBroadcastVersion,
    tx: BroadcastVersionsTx,
  ): Promise<BroadcastVersion>;

  /**
   * Overwrite the content of the working copy `versionId`. Matches only while
   * `sent_to_member_at IS NULL`; returns `null` when no row matched (the
   * version was sent, or does not exist). The optimistic-concurrency check
   * is the CALLER's, made under the broadcast row lock — never a SQL
   * `updated_at = $x` compare, which µs-vs-ms precision would defeat.
   */
  updateWorkingCopy(
    tenantId: TenantSlug,
    versionId: BroadcastVersionId,
    write: WorkingCopyWrite,
    tx: BroadcastVersionsTx,
  ): Promise<BroadcastVersion | null>;

  /**
   * F119 T059 — stamp `sent_to_member_at` on the working copy `versionId`,
   * the moment it is sent to the member. From then on the version is
   * read-only (`broadcast_versions_immutable_after_send_fn` freezes every
   * stamped row). Matches only while `sent_to_member_at IS NULL`; returns
   * `null` when no row matched — the caller treats that as an invariant
   * breach under its broadcast row lock and throws.
   */
  markSent(
    tenantId: TenantSlug,
    versionId: BroadcastVersionId,
    sentAt: Date,
    tx: BroadcastVersionsTx,
  ): Promise<BroadcastVersion | null>;
}
