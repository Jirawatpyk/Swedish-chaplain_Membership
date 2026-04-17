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
import { contacts } from './schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type {
  ContactRepo,
} from '../../application/ports/contact-repo';
import type { RepoError } from '../../application/ports/member-repo';
import type { Contact, ContactId } from '../../domain/contact';
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
    isPrimary: c.isPrimary,
    dateOfBirth: c.dateOfBirth ? new Date(c.dateOfBirth) : null,
    linkedUserId: c.linkedUserId as UserId | null,
    removedAt: c.removedAt,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

function unexpected(cause: unknown): RepoError {
  return { code: 'repo.unexpected', cause };
}

export const drizzleContactRepo: ContactRepo = {
  async listByMember(ctx, memberId, options) {
    try {
      const rows = await runInTenant(ctx, (tx) => {
        const base = tx
          .select()
          .from(contacts)
          .where(eq(contacts.memberId, memberId));
        return options?.includeRemoved
          ? base
          : tx
              .select()
              .from(contacts)
              .where(
                and(
                  eq(contacts.memberId, memberId),
                  sql`${contacts.removedAt} IS NULL`,
                ),
              );
      });
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

  async add(ctx, draft, actorUserId, requestId) {
    try {
      const inserted = await runInTenant(ctx, async (tx) => {
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
        const c = rows[0]!;
        await tx.insert(auditLog).values({
          eventType: 'contact_created',
          actorUserId,
          summary: `contact_created for member ${c.memberId}`,
          requestId,
          tenantId: ctx.slug,
          payload: {
            member_id: c.memberId,
            contact_id: c.contactId,
            is_primary: c.isPrimary,
          },
        });
        return c;
      });
      return ok(rowToContact(inserted));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key|unique constraint/i.test(msg)) {
        return err({
          code: 'repo.conflict',
          reason: 'duplicate primary or unique email',
        });
      }
      return err(unexpected(e));
    }
  },

  async update(ctx, contactId, patch, actorUserId, requestId) {
    try {
      const rows = await runInTenant(ctx, async (tx) => {
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
        if (updated.length > 0) {
          await tx.insert(auditLog).values({
            eventType: 'contact_updated',
            actorUserId,
            summary: `contact_updated ${contactId}`,
            requestId,
            tenantId: ctx.slug,
            payload: {
              member_id: updated[0]!.memberId,
              contact_id: contactId,
              fields_changed: Object.keys(patch),
            },
          });
        }
        return updated;
      });
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToContact(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async remove(ctx, contactId, actorUserId, requestId) {
    try {
      const rows = await runInTenant(ctx, async (tx) => {
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
        if (updated.length > 0) {
          await tx.insert(auditLog).values({
            eventType: 'contact_removed',
            actorUserId,
            summary: `contact_removed ${contactId}`,
            requestId,
            tenantId: ctx.slug,
            payload: {
              member_id: updated[0]!.memberId,
              contact_id: contactId,
              was_primary: wasPrimary,
            },
          });
        }
        return updated;
      });
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToContact(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async linkUser(ctx, contactId, userId, actorUserId, requestId) {
    try {
      const rows = await runInTenant(ctx, async (tx) => {
        // Fetch + check — refuse to overwrite an existing linked user.
        const [before] = await tx
          .select({
            linkedUserId: contacts.linkedUserId,
            memberId: contacts.memberId,
          })
          .from(contacts)
          .where(eq(contacts.contactId, contactId))
          .limit(1);
        if (!before) return null;
        if (before.linkedUserId) {
          throw new Error('CONFLICT_LINKED');
        }
        const updated = await tx
          .update(contacts)
          .set({ linkedUserId: userId, updatedAt: new Date() })
          .where(eq(contacts.contactId, contactId))
          .returning();
        if (updated.length > 0) {
          await tx.insert(auditLog).values({
            eventType: 'contact_updated',
            actorUserId,
            targetUserId: userId,
            summary: `linked user for contact ${contactId}`,
            requestId,
            tenantId: ctx.slug,
            payload: {
              member_id: updated[0]!.memberId,
              contact_id: contactId,
              linked_user_id: userId,
              fields_changed: ['linked_user_id'],
            },
          });
        }
        return updated;
      });
      if (rows === null) return err({ code: 'repo.not_found' });
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToContact(rows[0]!));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg === 'CONFLICT_LINKED') {
        return err({
          code: 'repo.conflict',
          reason: 'contact already linked to a user',
        });
      }
      return err(unexpected(e));
    }
  },

  async listLinkedUserIdsForMemberInTx(tx, memberId) {
    const rows = await tx
      .select({ linkedUserId: contacts.linkedUserId })
      .from(contacts)
      .where(
        and(
          eq(contacts.memberId, memberId),
          isNull(contacts.removedAt),
        ),
      );
    return rows
      .map((r) => r.linkedUserId)
      .filter((uid): uid is string => uid !== null);
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
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key|unique constraint/i.test(msg)) {
        return err({
          code: 'repo.conflict',
          reason: 'contact email already used in this tenant',
        });
      }
      return err({ code: 'repo.unexpected', cause: e });
    }
  },

  async promotePrimary(ctx, memberId, newPrimaryContactId, actorUserId, requestId) {
    try {
      const result = await runInTenant(ctx, async (tx) => {
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
            ),
          )
          .returning();
        if (promoted.length === 0) {
          throw new Error('target contact not found');
        }
        await tx.insert(auditLog).values({
          eventType: 'member_primary_contact_changed',
          actorUserId,
          summary: `primary_contact_changed for ${memberId}`,
          requestId,
          tenantId: ctx.slug,
          payload: {
            member_id: memberId,
            old_primary_contact_id: demoted[0]?.contactId ?? null,
            new_primary_contact_id: newPrimaryContactId,
          },
        });
        return { demoted: demoted[0], promoted: promoted[0]! };
      });
      const demotedRow = result.demoted;
      if (!demotedRow)
        return err({ code: 'repo.conflict', reason: 'no current primary' });
      return ok({
        demoted: rowToContact(demotedRow),
        promoted: rowToContact(result.promoted),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key|unique constraint/i.test(msg)) {
        return err({
          code: 'repo.conflict',
          reason: 'primary partial-index race',
        });
      }
      return err(unexpected(e));
    }
  },
};
