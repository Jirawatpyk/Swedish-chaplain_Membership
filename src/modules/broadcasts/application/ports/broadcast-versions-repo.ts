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
 * thread needs the whole list anyway), one insert and one working-copy
 * update. No delete path (the parent's ON DELETE CASCADE is the only one),
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
import type { BroadcastActorRole, BroadcastId } from '../../domain/broadcast';
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
    versionId: string,
    write: WorkingCopyWrite,
    tx: BroadcastVersionsTx,
  ): Promise<BroadcastVersion | null>;
}
