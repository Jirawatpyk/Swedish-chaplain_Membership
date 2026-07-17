# Staff Invitation Lifecycle — Design

**Date:** 2026-07-17 · **Surface:** `/admin/users` (F1 auth) · **Cross-cuts:** F3 members/contacts

## Problem

`/admin/users` can *invite* staff/members but cannot manage the invite afterward:

- **No Resend.** Invitations expire after 7 days (`INVITATION_TTL_MS`); the user then stays `pending` forever. Re-inviting the same email fails with `email-taken` (the pending row persists). Stuck.
- **No Revoke.** A typo'd / wrong invite can't be removed → the email is locked out of re-invite.
- **No expiry visibility.** The table shows a `pending` badge but not whether the invite is still live or expired — both look identical.
- **No cleanup.** Expired `pending` rows accumulate (no prune job).

The mechanism already exists but is only wired for **member contacts** (`resend-bounced-invite` on the member detail page), never for staff.

## F3 cross-check (why this doesn't become a new gap)

`/admin/users` lists **all roles**, so member-linked pending users appear there too. Deleting/reissuing them must not break F3:

- **`contacts.linked_user_id` FK is `ON DELETE SET NULL`** (migration 0009). Hard-deleting a pending user cleanly **unlinks** the contact — member data is preserved and the contact reverts to re-invitable. Deletion is F3-safe.
- **`reissueInvitation` does NOT audit** (it only logs + emits a metric). The F3 member-resend route emits its own `member_portal_invite_queued` at the **route** level. → We emit the new `invitation_reissued` at the **staff route** level only, so a member-linked resend is never double-audited.
- F3 already soft-consumes pending invites on archive via `InvitationCascadePort.softConsumePendingForUsersInTx` — our revoke/prune stay consistent (kill the invite; here by deleting the pending user, which SET-NULLs the link).

**Parallel pre-existing gap:** member-contact invites also had no cleanup/revoke. The auth-level Revoke + Prune below now cover member-linked pending users too, partially closing it. A dedicated member-page "revoke invite" button is a noted follow-up.

## Design

### A. Resend invitation
- `POST /api/auth/users/[id]/reissue-invite` — admin-gated (mirrors `disable`/`enable`/`role`).
- Calls existing `reissueInvitation({ userId, invitedByUserId: actor, locale, tenantId, requestId })` — already locks the row, refuses unless `status='pending'`, and re-derives `intendedRole` from the row.
- Route emits `invitation_reissued` audit (5y retention).
- UI: "Resend invitation" action on `pending` rows in `user-list-table`.

### B. Revoke invitation
- New `revokeInvitation({ userId, actorUserId, sourceIp, requestId, targetEmail })` use case (`deleteInvitedUser` is unusable — it needs the original `outboxRowId`):
  1. `deleteInvitedPendingInTx(userId)` — `DELETE users WHERE id=? AND status='pending'` (SET-NULLs any contact link).
  2. Delete this user's pending `notifications_outbox` invite rows (by user/email) so a queued invite can't still dispatch.
  3. Invitation token rows go via their FK on `users` (verify ondelete = CASCADE; else explicit delete).
  4. Emit `invitation_revoked` audit.
- `POST /api/auth/users/[id]/revoke-invite` + destructive confirm dialog.
- Frees the email → re-invite works.

### C. Expiry visibility
- `userRepo.listWithFilter` surfaces the latest invitation `expiresAt` per `pending` user.
- `user-list-table` shows `invited Nd ago` / `expired` next to the `pending` badge.

### D. Audit events (migration + 4-place update)
- Add to the `audit_event_type` enum: `invitation_reissued`, `invitation_revoked`, `invitation_expired`.
- 4 places (per repo convention): domain tuple (`audit-event.ts`), pgEnum (`schema.ts`), `tests/unit/auth/domain/audit-event.test.ts` count, `tests/integration/audit/completeness.test.ts`.
- New migration `ALTER TYPE ... ADD VALUE` (mirror `0198`). 5y default retention.

### E. Prune cron
- New `pruneExpiredInvitations({ olderThan })` use case: delete `pending` users whose latest invitation `expires_at < now - 30 days` (grace so Resend still works meanwhile). Batched; emits `invitation_expired` per pruned user.
- `GET /api/cron/auth/prune-expired-invitations` — native Vercel Cron, **GET-only** (per repo cron convention), `CRON_SECRET` bearer.
- `vercel.json` crons entry.

## Testing (TDD)
- **Contract:** the 3 routes (reissue, revoke, prune-cron) — RBAC, 200/404/409(`not-pending`), auth.
- **Unit:** `revokeInvitation`, `pruneExpiredInvitations` (incl. the 30-day boundary + member-linked SET-NULL path).
- **Integration (live Neon):** revoke unlinks a member-linked contact without deleting it; prune respects the 30-day grace; audit rows written.
- **i18n:** EN/TH/SV for all new strings.

## Out of scope / follow-ups
- Member-page "revoke invite" button (parallel gap; auth-level revoke/prune mitigate).
- Bulk resend/revoke.
