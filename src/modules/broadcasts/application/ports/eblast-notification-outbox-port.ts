/**
 * F119 — `EblastNotificationOutboxPort` Application port
 * (contracts/dashboard-and-notifications.md § 3, research R14).
 *
 * Enqueues one `notifications_outbox` row for an approval-round hand-off,
 * INSIDE the state-changing transaction (SC-004: roll the tx back and no
 * row exists). The same outbox the F7 transactional emails use; it differs
 * from `EmailTransactionalPort.sendMemberEmail` on one point that matters:
 * `contextData` carries **ids and discriminators only** — never a subject,
 * body, note or reason. The dispatcher arm (T065) reads the rows at send
 * time, so the erasure scrub of the version / decision rows also blanks
 * anything a not-yet-sent email would show, and a sent outbox row holds no
 * content at all.
 *
 * The enqueue is unconditional: nothing on the state-changing path reads
 * `FEATURE_EBLAST_MEMBER_APPROVAL`. The flag lives at the drainer (T152a),
 * which skips these five types while it is off.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantContext } from '@/modules/tenants';
import type { MemberDecisionKind } from '../../domain/approval/member-decision';

/** The five 0308 `notification_type` values (data-model § 7.3). */
export const F119_NOTIFICATION_TYPES = [
  'eblast_submitted_marketing',
  'eblast_member_decided_marketing',
  'eblast_version_sent_member',
  'eblast_schedule_confirmed_member',
  'eblast_approval_lifecycle',
] as const;

export type F119NotificationType = (typeof F119_NOTIFICATION_TYPES)[number];

/** The `kind` of `eblast_approval_lifecycle` — the four steps of the approval clock (FR-022, FR-022a). */
export type EblastApprovalLifecycleKind = 'reminder_day3' | 'reminder_day7' | 'expiry_warning_day23' | 'expired_day30';

/**
 * The two ids every approval-round row carries. A type alias, not an
 * interface: the adapter writes the context as a JSON record, and only an
 * alias carries the implicit index signature that assignment needs.
 */
type EblastContextIds = {
  readonly tenantId: string;
  readonly broadcastId: string;
};

/**
 * #400 item 3 — the `context_data` of each type: EXACTLY the keys its producer
 * writes and its dispatcher arm reads (`src/lib/broadcast-approval-
 * notifications.ts`). It used to be an untyped `Record`, so a producer that
 * dropped `round` compiled and the email was lost at send time as
 * `malformed_context`. Ids and discriminators ONLY (§ 3) — never a subject,
 * body, note or reason.
 */
export interface EblastNotificationContexts {
  /** `submit-broadcast` — one per marketing roster recipient. */
  readonly eblast_submitted_marketing: EblastContextIds & { readonly recipientUserId: string };
  /**
   * `record-member-decision` (a decision in round N, on the version it names)
   * and `cancel-broadcast` (the member's WITHDRAWAL of the whole E-Blast: no
   * version, and no round before the first one).
   */
  readonly eblast_member_decided_marketing: EblastContextIds & { readonly recipientUserId: string } & (
      | { readonly decision: MemberDecisionKind; readonly versionId: string; readonly round: number }
      | { readonly decision: 'withdrawn'; readonly versionId: null; readonly round: number | null }
    );
  /** `send-version-to-member` — round N is ready. */
  readonly eblast_version_sent_member: EblastContextIds & { readonly versionId: string; readonly round: number };
  /** `confirm-schedule` — the approved version whose send time is confirmed (no round). */
  readonly eblast_schedule_confirmed_member: EblastContextIds & { readonly versionId: string };
  /** `expire-stale-member-approvals` — the member row, and one per roster recipient on the staff steps. */
  readonly eblast_approval_lifecycle: EblastContextIds & {
    readonly versionId: string;
    readonly round: number;
    readonly kind: EblastApprovalLifecycleKind;
  } & ({ readonly audience: 'member' } | { readonly audience: 'staff'; readonly recipientUserId: string });
}

/** One enqueue: a discriminated union on `type`, so a row can only carry ITS type's context. */
export type EblastNotificationEnqueue = {
  readonly [T in F119NotificationType]: {
    readonly type: T;
    readonly toEmail: string;
    /** The recipient's language: the member contact's `preferred_language` (FR-024). */
    readonly locale: 'en' | 'th' | 'sv';
    readonly contextData: EblastNotificationContexts[T];
  };
}[F119NotificationType];

export interface EblastNotificationOutboxPort {
  /** Insert one pending outbox row on the caller's `runInTenant` tx — REQUIRED, never the pool-global `db`. */
  enqueueInTx(tx: unknown, tenant: TenantContext, request: EblastNotificationEnqueue): Promise<void>;
}
