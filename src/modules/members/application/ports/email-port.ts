/**
 * Application port — transactional email dispatch via an outbox row.
 *
 * Per plan.md § Reliability: the DB transaction that mutates state
 * ENQUEUES an outbox row; a post-commit dispatcher sends via Resend.
 * Resend failure never rolls back the domain transaction — retries
 * come from the outbox retry loop.
 *
 * F3 notification types (FR-012a + carry-over from F1 invitation).
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { RepoError } from './member-repo';

export type EmailNotificationType =
  | 'member_invitation'
  | 'email_verification'
  | 'email_change_revert'
  | 'email_verification_resent'
  // F114 (migration 0301) — one row per reviewer on submit (FR-011) and one
  // row for the submitter on decide (FR-023). `contextData` = ids + field
  // keys ONLY; the diff is rendered at send time from the request rows.
  | 'member_change_request_submitted_staff'
  | 'member_change_request_decided_member';

export type EmailEnqueue = {
  readonly type: EmailNotificationType;
  readonly toEmail: string;
  readonly locale: 'en' | 'th' | 'sv';
  readonly contextData: Record<string, unknown>;
};

export interface EmailPort {
  enqueue(
    ctx: TenantContext,
    request: EmailEnqueue,
  ): Promise<Result<{ outboxRowId: string }, RepoError>>;

  /**
   * Enqueue inside a caller-provided transaction. Required by the
   * FR-012a 6-step atomic txn so the outbox row commits atomically
   * with the state mutations — Resend dispatch failures after commit
   * are handled by the outbox retry loop, never by a rollback.
   */
  enqueueInTx(
    tx: TenantTx,
    ctx: TenantContext,
    request: EmailEnqueue,
  ): Promise<Result<{ outboxRowId: string }, RepoError>>;
}
