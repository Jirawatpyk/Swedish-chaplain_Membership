/**
 * OutboxCancelPort adapter — COMP-1 US2a / L1.
 *
 * DELETEs pending `notifications_outbox` rows by frozen `to_email` inside the
 * caller's transaction. Mirrors the `deleteOutboxInTx` pattern in
 * `delete-invited-user.ts` (which removes a queued invite outbox row so no dead
 * email is dispatched) — generalised to a set of addresses + a `status='pending'`
 * guard so already-sent / permanently_failed history is preserved.
 *
 * `notifications_outbox` is tenant-scoped (RLS+FORCE since migration 0098); the
 * caller threads the `tx` from `runInTenant`, so the row-level RLS policy
 * (`tenant_id = current_setting('app.current_tenant')`) confines the DELETE to
 * the erased member's tenant — no manual `tenant_id` filter needed (and the
 * GUC is set, unlike the cross-tenant owner-role `eraseUser` tx).
 *
 * COMP-1 FIX-4 — the DELETE adds a two-pronged cross-member OWNERSHIP guard
 * (parameterised by `erasedMemberId`) so erasing member A cannot cancel a PEER
 * member B's legitimately-pending mail that shares an address with A. The
 * cancel-set unions A's contact emails WITH A's linked-login emails (U.email)
 * and the invalidated-token emails; the login/token arms have NO owner key, and
 * `contacts.linked_user_id` has no unique constraint (two members can link the
 * same login U), so a bare `to_email = ANY(emails)` DELETE removes B's pending
 * mail to the shared login. The guard excludes any row whose `to_email` is the
 * CONTACT email (guard 1) or the LINKED-LOGIN email (guard 2) of a DIFFERENT
 * live member. `member_id <> erasedMemberId` makes it ORDERING-INDEPENDENT
 * (works whether or not A's own contacts are already removed/scrubbed by
 * cancel-time, since the contacts scrub stamps `removed_at` but the guard only
 * protects PEER rows).
 *
 * Raw SQL (parameterised) — the DELETE references the `notifications_outbox`,
 * `contacts`, and `users` tables by NAME (not Drizzle schema objects), so no
 * schema import is needed. `contacts` is intra-module (members); `users` lives
 * in the auth schema — referencing it by name inside the tenant-scoped tx is
 * the same documented cross-module escape hatch the prior Drizzle-builder
 * version used for `notifications_outbox`. RLS (FORCE on notifications_outbox)
 * + the GUC set by `runInTenant` confine the DELETE to the erased tenant; the
 * two NOT EXISTS guards key on `member_id <> erasedMemberId` for cross-member
 * safety.
 */
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';
import { err, ok } from '@/lib/result';
import type { OutboxCancelPort } from '../../application/ports/outbox-cancel-port';

export const outboxCancelAdapter: OutboxCancelPort = {
  async cancelPendingForEmailsInTx(txUnknown, emails, erasedMemberId) {
    // Empty work-list → no-op (avoid a degenerate `ANY('{}')` scan). Cheap
    // guard so an erased member with no queued mail does not touch the table.
    if (emails.length === 0) return ok({ cancelledCount: 0 });
    const tx = txUnknown as TenantTx;
    try {
      // Raw DELETE so the two cross-member ownership guards (NOT EXISTS
      // anti-joins on `contacts` / `contacts ⨝ users`) can sit in the WHERE
      // clause. `= ANY(ARRAY[...]::text[])` is the Neon-safe array form
      // (mirrors the broadcasts redaction repo); a bare JS array errors 22P02.
      const deleted = (await tx.execute(sql`
        DELETE FROM notifications_outbox o
        WHERE o.to_email = ANY(ARRAY[${sql.join(
          emails.map((e) => sql`${e}`),
          sql`, `,
        )}]::text[])
          AND o.status = 'pending'
          -- guard 1: protect a peer member's CONTACT-addressed mail (covers the
          -- contact arm's live-live collision + a token email that is a peer's
          -- contact address).
          AND NOT EXISTS (
            SELECT 1 FROM contacts c
            WHERE c.member_id <> ${erasedMemberId}
              AND c.removed_at IS NULL
              AND lower(c.email) = lower(o.to_email)
          )
          -- guard 2: protect a peer member's LOGIN-addressed mail (the linked-
          -- login arm: a login U shared via contacts on a DIFFERENT live
          -- member). contacts.linked_user_id has no unique constraint, so
          -- erasing A must not cancel B's mail to a shared login.
          AND NOT EXISTS (
            SELECT 1 FROM contacts c2
            JOIN users u ON u.id = c2.linked_user_id
            WHERE c2.member_id <> ${erasedMemberId}
              AND c2.removed_at IS NULL
              AND lower(u.email) = lower(o.to_email)
          )
        RETURNING o.id
      `)) as unknown as Array<{ id: string }>;
      return ok({ cancelledCount: deleted.length });
    } catch (e) {
      return err({ code: 'repo.unexpected', cause: e });
    }
  },
};
