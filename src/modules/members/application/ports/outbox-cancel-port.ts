/**
 * Application port — cancel pending transactional-outbox rows during erasure
 * (COMP-1 US2a / L1).
 *
 * GDPR Art.17 / PDPA §33 erasure soft-consumes invitations but, before this
 * port, never cancelled the linked users' queued `notifications_outbox` rows.
 * Each row's `to_email` is FROZEN at enqueue = the subject's real address, and
 * the retry ladder keeps a once-failed row `pending` for up to 12h — so the
 * dispatcher could still email the erased subject AFTER erasure completed.
 *
 * `eraseMember` calls this INSIDE its atomic scrub tx, mirroring
 * `delete-invited-user.ts` (which deletes the queued invite outbox row "so no
 * dead invite email is dispatched"). `notifications_outbox` is tenant-scoped
 * (RLS+FORCE since migration 0098, `tenant_id NOT NULL`), so the delete MUST
 * run inside a `runInTenant` tx — it cannot live in the cross-tenant
 * owner-role `eraseUser` tx.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { MemberId } from '../../domain/member';
import type { RepoError } from './member-repo';

export interface OutboxCancelPort {
  /**
   * DELETE every `pending` `notifications_outbox` row whose `to_email` is in
   * `emails`, inside the caller's tenant-scoped transaction. Only `pending`
   * rows are removed — `sent` / `permanently_failed` rows are an immutable
   * historical record and are left untouched. Idempotent (a re-drive deletes
   * 0 rows). Returns the number of rows cancelled.
   *
   * `emails` empty ⇒ no-op, returns `{ cancelledCount: 0 }`. FAIL-LOUD: a DB
   * error returns `err` so the caller's atomic erasure tx rolls back rather
   * than leaving a dispatchable row behind under a falsely-"complete" erasure.
   *
   * COMP-1 FIX-4 (cross-member over-delete guard) — `erasedMemberId` scopes the
   * DELETE so it cannot remove a PEER member's legitimately-pending mail that
   * shares an address with the erased subject. The cancel-set unions the erased
   * member's contact emails WITH its linked-login emails (U.email) and the
   * invalidated-token emails; the login/token arms have NO inherent owner key,
   * and `contacts.linked_user_id` has no unique constraint (two members can
   * link the SAME login U), so a naive `to_email IN (emails)` DELETE removes a
   * peer member's pending mail to the shared login. The adapter therefore adds
   * a two-pronged ownership guard, parameterised by `erasedMemberId`
   * (ORDERING-INDEPENDENT — `member_id <> erasedMemberId`):
   *   guard 1 — protect a peer member's CONTACT-addressed mail;
   *   guard 2 — protect a peer member's LOGIN-addressed mail (a login shared via
   *             contacts on a DIFFERENT live member).
   */
  cancelPendingForEmailsInTx(
    tx: TenantTx,
    emails: readonly string[],
    erasedMemberId: MemberId,
  ): Promise<Result<{ readonly cancelledCount: number }, RepoError>>;
}
