/**
 * Drizzle + RLS implementation of ContactRepo (T048).
 *
 * Same tenant-scoping pattern as drizzle-member-repo.ts — every method
 * runs inside runInTenant(). The partial unique index
 * `contacts_one_primary_per_member` enforces FR-003 at the DB layer;
 * this repo maps the resulting Postgres unique-violation to
 * `repo.conflict` so callers get a clean error instead of a leaky 500.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { err, ok } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { mapDbError, unexpected } from './_repo-error';
import { contacts } from './schema-contacts';
import type {
  ContactRepo,
} from '../../application/ports/contact-repo';
import { contactPrimacy, type Contact, type ContactId } from '../../domain/contact';
import {
  ERASED_EMAIL_DOMAIN,
  ERASED_EMAIL_LOCAL_PREFIX,
  ERASED_SENTINEL,
} from '../../domain/erasure-sentinels';
import type { MemberId, TenantId } from '../../domain/member';
import type { Email } from '../../domain/value-objects/email';
import type { Phone } from '../../domain/value-objects/phone';
import type { UserId } from '../../domain/value-objects/user-id';

export function rowToContact(c: typeof contacts.$inferSelect): Contact {
  return {
    tenantId: c.tenantId as TenantId,
    contactId: c.contactId as ContactId,
    memberId: c.memberId as MemberId,
    firstName: c.firstName,
    lastName: c.lastName,
    email: c.email as Email,
    phone: c.phone as Phone | null,
    roleTitle: c.roleTitle,
    preferredLanguage: c.preferredLanguage as 'en' | 'th' | 'sv',
    dateOfBirth: c.dateOfBirth ? new Date(c.dateOfBirth) : null,
    linkedUserId: c.linkedUserId as UserId | null,
    inviteBouncedAt: c.inviteBouncedAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    // M5: narrow into the correlated primacy union (isPrimary ⟹ not removed).
    ...contactPrimacy(c.isPrimary, c.removedAt),
  };
}

export const drizzleContactRepo: ContactRepo = {
  async listByMember(ctx, memberId, options) {
    try {
      const conds = [eq(contacts.memberId, memberId)];
      if (!options?.includeRemoved) conds.push(isNull(contacts.removedAt));
      const rows = await runInTenant(ctx, (tx) =>
        tx.select().from(contacts).where(and(...conds)),
      );
      return ok(rows.map(rowToContact));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findById(ctx, contactId) {
    try {
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select()
          .from(contacts)
          .where(eq(contacts.contactId, contactId))
          .limit(1),
      );
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToContact(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findByEmail(ctx, email) {
    try {
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.tenantId, ctx.slug),
              eq(contacts.email, email),
              isNull(contacts.removedAt),
            ),
          )
          .limit(1),
      );
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToContact(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async addInTx(tx, draft) {
    try {
      const rows = await tx
        .insert(contacts)
        .values({
          tenantId: draft.tenantId,
          contactId: draft.contactId,
          memberId: draft.memberId,
          firstName: draft.firstName,
          lastName: draft.lastName,
          email: draft.email,
          phone: draft.phone,
          roleTitle: draft.roleTitle,
          preferredLanguage: draft.preferredLanguage,
          isPrimary: draft.isPrimary,
          dateOfBirth: draft.dateOfBirth?.toISOString().slice(0, 10) ?? null,
          linkedUserId: draft.linkedUserId,
          removedAt: null,
        })
        .returning();
      return ok(rowToContact(rows[0]!));
    } catch (e) {
      return err(mapDbError(e, 'duplicate primary or unique email'));
    }
  },

  async updateInTx(tx, contactId, patch) {
    try {
      const updated = await tx
        .update(contacts)
        .set({
          ...(patch.firstName !== undefined && { firstName: patch.firstName }),
          ...(patch.lastName !== undefined && { lastName: patch.lastName }),
          ...(patch.phone !== undefined && { phone: patch.phone }),
          ...(patch.roleTitle !== undefined && { roleTitle: patch.roleTitle }),
          ...(patch.preferredLanguage !== undefined && {
            preferredLanguage: patch.preferredLanguage,
          }),
          updatedAt: new Date(),
        })
        .where(eq(contacts.contactId, contactId))
        .returning();
      if (updated.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToContact(updated[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async removeInTx(tx, contactId) {
    try {
      // Capture isPrimary BEFORE the UPDATE — RETURNING reflects
      // post-SET values, and SET forces isPrimary=false.
      const [before] = await tx
        .select({ isPrimary: contacts.isPrimary })
        .from(contacts)
        .where(eq(contacts.contactId, contactId))
        .limit(1);
      const wasPrimary = before?.isPrimary ?? false;

      const updated = await tx
        .update(contacts)
        .set({ removedAt: new Date(), isPrimary: false })
        .where(eq(contacts.contactId, contactId))
        .returning();
      if (updated.length === 0) return err({ code: 'repo.not_found' });
      return ok({ contact: rowToContact(updated[0]!), wasPrimary });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async linkUserInTx(tx, contactId, userId) {
    try {
      // Atomic conditional UPDATE — the `isNull(linkedUserId)` guard in
      // the WHERE clause eliminates the SELECT-then-UPDATE TOCTOU race
      // where two concurrent callers could both see `linkedUserId=null`
      // and race to link. `0 rows updated` means either the contact
      // doesn't exist OR it's already linked; distinguish with a
      // targeted follow-up SELECT only when the update affected nothing.
      const updated = await tx
        .update(contacts)
        .set({ linkedUserId: userId, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.contactId, contactId),
            isNull(contacts.linkedUserId),
          ),
        )
        .returning();
      if (updated.length > 0) return ok(rowToContact(updated[0]!));

      // 0 rows updated → probe to give a precise error code.
      const [probe] = await tx
        .select({ contactId: contacts.contactId })
        .from(contacts)
        .where(eq(contacts.contactId, contactId))
        .limit(1);
      if (!probe) return err({ code: 'repo.not_found' });
      return err({
        code: 'repo.conflict',
        reason: 'contact already linked to a user',
      });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async listLinkedUserIdsForMemberInTx(tx, memberId) {
    // NO try/catch: a thrown DB error (statement timeout / connection blip)
    // MUST propagate so the caller's runInTenant tx ROLLS BACK. An empty
    // array means "genuinely no linked users", never "a read failed".
    // This read drives the Art.17/PDPA §33 cascade that revokes the erased
    // member's F1 sessions + pending invitations (erase-member.ts / Bug I-1)
    // and the equivalent archive cascade (archive-member.ts / US7). If a
    // transient read error were swallowed to [], the cascade would silently
    // no-op while the scrub/status-flip still committed — leaving the erased
    // member's login alive AND emitting member_erased as "complete" so the
    // US2 reconciler (keyed on member_erased) never re-drives it. Failing
    // loud rolls the whole tx back: no partial scrub, no false completion.
    const rows = await tx
      .select({ linkedUserId: contacts.linkedUserId })
      .from(contacts)
      .where(and(eq(contacts.memberId, memberId), isNull(contacts.removedAt)));
    return rows
      .map((r) => r.linkedUserId)
      .filter((uid): uid is string => uid !== null);
  },

  async listAllLinkedUserIdsForMemberInTx(tx, memberId) {
    // NO try/catch: a thrown DB error (statement timeout / connection blip)
    // MUST propagate so the caller's runInTenant tx ROLLS BACK. An empty
    // array means "genuinely no linked users", never "a read failed".
    //
    // UNLIKE listLinkedUserIdsForMemberInTx, this read is NOT filtered by
    // `removed_at IS NULL` — it deliberately INCLUDES the linked logins of
    // contacts whose row was already removed_at-stamped by the erasure scrub
    // (which preserves linked_user_id). This is the F1 linked-login ERASURE
    // work-list source (erase-member.ts / COMP-1 US2a): it must survive the
    // contacts scrub so a US2d reconciler RE-DRIVE re-discovers every login and
    // re-attempts one that FAILED to erase on a prior pass. If it filtered
    // removed_at IS NULL (or swallowed a read error to []), the re-drive would
    // skip the previously-failed login while member_erased was emitted as
    // "complete" — leaving the erased member's credential alive forever
    // (Art.17 credential survival). Failing loud rolls the whole tx back: no
    // partial scrub, no false completion.
    const rows = await tx
      .select({ linkedUserId: contacts.linkedUserId })
      .from(contacts)
      .where(eq(contacts.memberId, memberId));
    return rows
      .map((r) => r.linkedUserId)
      .filter((uid): uid is string => uid !== null);
  },

  async markInviteBouncedInTx(tx, contactId, bouncedAt) {
    try {
      // Tenant-scoped via the caller's runInTenant tx (RLS scopes the row to
      // the owner tenant). Idempotent guard: only stamp a live, not-yet-marked
      // contact — re-deliveries of the same bounce no-op (affected: 0).
      const updated = await tx
        .update(contacts)
        .set({ inviteBouncedAt: bouncedAt, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.contactId, contactId),
            isNull(contacts.removedAt),
            isNull(contacts.inviteBouncedAt),
          ),
        )
        .returning({ contactId: contacts.contactId });
      return ok({ affected: updated.length });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async clearInviteBouncedInTx(tx, contactId) {
    try {
      // Clears invite_bounced_at = NULL. Tenant-scoped via the caller's
      // runInTenant tx. Idempotent: if already NULL the update affects 0 rows.
      // No WHERE guard on removedAt — we allow clearing on a removed contact
      // to avoid a confusing stuck-in-bounced state if archiving races with
      // a resend. The use-case guards `not_bounced` before this is called.
      const updated = await tx
        .update(contacts)
        .set({ inviteBouncedAt: null, updatedAt: new Date() })
        .where(eq(contacts.contactId, contactId))
        .returning({ contactId: contacts.contactId });
      return ok({ affected: updated.length });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async listEmailsForMemberInTx(tx, memberId) {
    // NO try/catch: a thrown DB error (statement timeout / connection blip)
    // MUST propagate so the caller's runInTenant tx ROLLS BACK. An empty array
    // means "genuinely no contacts", never "a read failed". This read captures
    // the contacts' REAL emails BEFORE scrubPiiForMemberInTx sentinel-izes them
    // — the frozen `to_email` values of pending notifications_outbox rows the
    // erasure must cancel (L1). Unfiltered by removed_at (see port JSDoc).
    const rows = await tx
      .select({ email: contacts.email })
      .from(contacts)
      .where(eq(contacts.memberId, memberId));
    const emails = new Set<string>();
    for (const r of rows) if (r.email) emails.add(r.email);
    return [...emails];
  },

  async listLiveEmailsForMemberInTx(tx, memberId) {
    // NO try/catch: a thrown DB error MUST propagate so the caller's
    // runInTenant tx ROLLS BACK (fail-loud, mirrors listEmailsForMemberInTx).
    // UNLIKE listEmailsForMemberInTx, this filters `removed_at IS NULL` — it
    // returns the REAL emails of the member's LIVE contacts only. This is the
    // CONTACT-email component of the outbox cancel-set: a removed contact's
    // email is ambiguously owned (the partial contacts_tenant_email_uniq index
    // permits a DIFFERENT member's live contact to hold the same address), so
    // cancelling on it would delete that peer member's legitimate pending mail
    // (the COMP-1 US2a cross-member over-delete). Live emails are unambiguously
    // the erased member's now, so only those are safe to cancel on.
    const rows = await tx
      .select({ email: contacts.email })
      .from(contacts)
      .where(and(eq(contacts.memberId, memberId), isNull(contacts.removedAt)));
    const emails = new Set<string>();
    for (const r of rows) if (r.email) emails.add(r.email);
    return [...emails];
  },

  async listTombstoneEmailsForMemberInTx(tx, memberId) {
    // NO try/catch (fail-loud, mirrors listEmailsForMemberInTx — a thrown DB
    // error MUST roll back the erasure). ALL of the erased member's contact
    // emails (ANY removed_at), MINUS any email currently held by a LIVE contact
    // of a DIFFERENT member. Used for the email-keyed REDACTION ops (F7 delivery
    // tombstone, Resend audience-removal derivation, cross-author custom-
    // recipient redaction): these MUST cover a contact ARCHIVED before erasure
    // (its identity is scrubbed, so its historical recipient PII must be too)
    // but must NOT redact a PEER's live delivery / unsubscribe a peer from
    // Resend. For the rare collision (the erased member's email is ALSO a peer's
    // live contact) we leave the erased member's own datum — the SAME accepted
    // safer-failure residual as the live-only outbox guard (a residual self-
    // datum beats deleting/redacting a peer's data). RLS scopes BOTH `contacts`
    // references to the tenant via the caller's runInTenant tx — the
    // `peer.member_id <> ${memberId}` anti-join is the cross-member guard.
    const rows = (await tx.execute(sql`
      SELECT DISTINCT lower(c.email) AS email
      FROM contacts c
      WHERE c.member_id = ${memberId}
        AND c.email IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM contacts peer
          WHERE peer.member_id <> ${memberId}
            AND peer.removed_at IS NULL
            AND lower(peer.email) = lower(c.email)
        )
    `)) as unknown as Array<{ email: string | null }>;
    const emails = new Set<string>();
    for (const r of rows) if (r.email) emails.add(r.email);
    return [...emails];
  },

  async scrubPiiForMemberInTx(tx, memberId, opts) {
    try {
      // COMP-1 member erasure (GDPR Art.17 / PDPA §33). One UPDATE over every
      // contact of the member. Identity columns are NOT NULL so they take
      // non-PII SENTINELS, not NULL: first/last → '[erased]', email → a per-row
      // value built at the DB layer from the row's own contact_id so two erased
      // members never produce the same sentinel email. `removed_at` is stamped
      // so the row leaves the `contacts_tenant_email_uniq` partial index
      // (`lower(email) WHERE removed_at IS NULL`) — without it, the sentinel
      // emails would have to stay collision-free on a LIVE index. `is_primary`
      // is forced FALSE so the row also leaves `contacts_one_primary_per_member`
      // and respects the `contacts_primary_not_removed` CHECK. Tenant-scoped via
      // the caller's runInTenant tx (RLS); no manual tenant_id filter needed.
      // Idempotent: re-running yields the same stable sentinels per contact_id.
      //
      // `linked_user_id` is DELIBERATELY absent from this .set() — it is NOT
      // scrubbed/NULLed. The F1 linked-login erasure work-list
      // (`listAllLinkedUserIdsForMemberInTx`) and the US2d reconciler re-drive
      // re-discover a previously-FAILED linked login by reading
      // `linked_user_id` off the (now removed_at-stamped) contact rows AFTER
      // this scrub. NULLing it here would silently re-open the credential-
      // survival hole (a failed F1 erasure could never be re-driven → the
      // erased member's login stays alive forever). The invariant is guarded by
      // `erase-member-linked-user-shadow.test.ts`.
      const updated = await tx
        .update(contacts)
        .set({
          firstName: ERASED_SENTINEL,
          lastName: ERASED_SENTINEL,
          email: sql`${ERASED_EMAIL_LOCAL_PREFIX} || ${contacts.contactId} || '@' || ${ERASED_EMAIL_DOMAIN}`,
          phone: null,
          dateOfBirth: null,
          roleTitle: null,
          preferredLanguage: 'en',
          isPrimary: false,
          removedAt: opts.erasedAt,
          updatedAt: opts.erasedAt,
        })
        .where(eq(contacts.memberId, memberId))
        .returning({ contactId: contacts.contactId });
      return ok({ scrubbedCount: updated.length });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async updateEmailInTx(tx, _ctx, contactId, newEmail) {
    try {
      // SELECT the current email first — Postgres RETURNING on UPDATE
      // reflects post-SET values, not pre-SET, so a single UPDATE can
      // not hand back the old email.
      const [before] = await tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(eq(contacts.contactId, contactId))
        .limit(1);
      if (!before) return err({ code: 'repo.not_found' });

      const updated = await tx
        .update(contacts)
        .set({ email: newEmail, updatedAt: new Date() })
        .where(eq(contacts.contactId, contactId))
        .returning({ id: contacts.contactId });
      if (updated.length === 0) return err({ code: 'repo.not_found' });

      return ok({ oldEmail: before.email as typeof newEmail });
    } catch (e) {
      return err(mapDbError(e, 'contact email already used in this tenant'));
    }
  },

  async promotePrimaryInTx(tx, memberId, newPrimaryContactId) {
    try {
      // Demote current primary FIRST (partial unique index constraint)
      const demoted = await tx
        .update(contacts)
        .set({ isPrimary: false, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.memberId, memberId),
            eq(contacts.isPrimary, true),
            sql`${contacts.removedAt} IS NULL`,
          ),
        )
        .returning();
      const promoted = await tx
        .update(contacts)
        .set({ isPrimary: true, updatedAt: new Date() })
        .where(
          and(
            eq(contacts.contactId, newPrimaryContactId),
            eq(contacts.memberId, memberId),
            // A removed contact cannot become primary (DB CHECK
            // contacts_primary_not_removed). Excluding it here makes a
            // removed/missing target match 0 rows → clean repo.not_found,
            // instead of a CHECK violation surfacing as repo.unexpected (500).
            isNull(contacts.removedAt),
          ),
        )
        .returning();
      // Order is intentional: check the promotion TARGET first. If the target
      // contact does not exist / is not in this member, `not_found` is the most
      // specific, actionable error — preferred over `no current primary` even
      // when BOTH the demote and promote matched zero rows. Both error branches
      // return `err`, so the caller's throw-to-rollback undoes the demote either
      // way; the only thing the ordering decides is WHICH error the caller sees.
      if (promoted.length === 0) {
        return err({
          code: 'repo.not_found',
        });
      }
      const demotedRow = demoted[0];
      if (!demotedRow) {
        return err({ code: 'repo.conflict', reason: 'no current primary' });
      }
      return ok({
        demoted: rowToContact(demotedRow),
        promoted: rowToContact(promoted[0]!),
      });
    } catch (e) {
      return err(mapDbError(e, 'primary partial-index race'));
    }
  },
};
