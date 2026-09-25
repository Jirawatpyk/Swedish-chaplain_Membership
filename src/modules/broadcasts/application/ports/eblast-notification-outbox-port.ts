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

/** The five 0308 `notification_type` values (data-model § 7.3). */
export const F119_NOTIFICATION_TYPES = [
  'eblast_submitted_marketing',
  'eblast_member_decided_marketing',
  'eblast_version_sent_member',
  'eblast_schedule_confirmed_member',
  'eblast_approval_lifecycle',
] as const;

export type F119NotificationType = (typeof F119_NOTIFICATION_TYPES)[number];

export interface EblastNotificationEnqueue {
  readonly type: F119NotificationType;
  readonly toEmail: string;
  /** The recipient's language: the member contact's `preferred_language` (FR-024). */
  readonly locale: 'en' | 'th' | 'sv';
  /** Ids and discriminators ONLY (§ 3). */
  readonly contextData: Readonly<Record<string, string | number | null>>;
}

export interface EblastNotificationOutboxPort {
  /** Insert one pending outbox row on the caller's `runInTenant` tx — REQUIRED, never the pool-global `db`. */
  enqueueInTx(tx: unknown, tenant: TenantContext, request: EblastNotificationEnqueue): Promise<void>;
}
