/**
 * Drizzle + RLS implementation of MemberRepo (T047).
 *
 * Every method runs inside `runInTenant(tenant, fn)` which sets
 * `SET LOCAL ROLE chamber_app` + `SET LOCAL app.current_tenant` —
 * RLS then transparently scopes queries to the tenant. No explicit
 * `WHERE tenant_id = ?` appears here (F2 § 7.1 rationale).
 *
 * Row → Domain translation is handled by `rowToMember()` below; Drizzle's
 * inferred row shape never leaks into Application per Principle III.
 */

import { and, eq, ilike, inArray, or, sql, asc } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { err, ok, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans';
import { members, type MemberRow } from './schema-members';
import { contacts } from './schema-contacts';
import { rowToContact } from './drizzle-contact-repo';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type {
  DirectoryFilter,
  DirectoryRow,
  MemberPatch,
  MemberRepo,
  RepoError,
} from '../../application/ports/member-repo';
import type {
  Member,
  MemberId,
  TenantId,
  PlanId,
} from '../../domain/member';
import type { Contact, ContactId } from '../../domain/contact';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { TaxId } from '../../domain/value-objects/tax-id';
import type { Email } from '../../domain/value-objects/email';
import type { Phone } from '../../domain/value-objects/phone';
import type { UserId } from '../../domain/value-objects/user-id';

// --- Row → Domain ------------------------------------------------------------

function rowToMember(row: MemberRow): Member {
  return {
    tenantId: row.tenantId as TenantId,
    memberId: row.memberId as MemberId,
    companyName: row.companyName,
    legalEntityType: row.legalEntityType,
    country: row.country as IsoCountryCode,
    taxId: row.taxId as TaxId | null,
    website: row.website,
    description: row.description,
    foundedYear: row.foundedYear,
    turnoverThb: row.turnoverThb,
    planId: row.planId as PlanId,
    planYear: row.planYear,
    registrationDate: new Date(row.registrationDate),
    registrationFeePaid: row.registrationFeePaid,
    lastActivityAt: row.lastActivityAt,
    notes: row.notes,
    status: row.status,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function unexpected(cause: unknown): RepoError {
  return { code: 'repo.unexpected', cause };
}

// --- Shared helpers ---------------------------------------------------------

/** Build and execute the UPDATE + RETURNING for a member patch on any tx. */
function applyMemberPatch(
  tx: Parameters<Parameters<typeof runInTenant>[1]>[0],
  memberId: string,
  patch: MemberPatch,
) {
  // Build a typed SET object — only include fields that are present in
  // the patch. The Drizzle `.set()` typings under exactOptionalPropertyTypes
  // require concrete column types, not `unknown`.
  const set: typeof members.$inferInsert = { updatedAt: new Date() } as typeof members.$inferInsert;
  if (patch.companyName !== undefined) set.companyName = patch.companyName;
  if (patch.legalEntityType !== undefined) set.legalEntityType = patch.legalEntityType;
  if (patch.website !== undefined) set.website = patch.website;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.taxId !== undefined) set.taxId = patch.taxId;
  if (patch.turnoverThb !== undefined) set.turnoverThb = patch.turnoverThb;
  if (patch.foundedYear !== undefined) set.foundedYear = patch.foundedYear;
  if (patch.country !== undefined) set.country = patch.country;
  if (patch.planId !== undefined) set.planId = patch.planId;
  if (patch.planYear !== undefined) set.planYear = patch.planYear;

  return tx
    .update(members)
    .set(set)
    .where(eq(members.memberId, memberId))
    .returning();
}

// --- Implementation ---------------------------------------------------------

export const drizzleMemberRepo: MemberRepo = {
  async findById(ctx, memberId) {
    try {
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select()
          .from(members)
          .where(eq(members.memberId, memberId))
          .limit(1),
      );
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToMember(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findSoftDuplicate(ctx, companyName, country) {
    try {
      // Only match active/inactive members — archived members should
      // not block creation of a legitimate replacement (COR-4).
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select()
          .from(members)
          .where(
            and(
              ilike(members.companyName, companyName),
              eq(members.country, country),
              or(
                eq(members.status, 'active'),
                eq(members.status, 'inactive'),
              )!,
            ),
          )
          .limit(1),
      );
      return ok(rows.length === 0 ? null : rowToMember(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async createWithPrimaryContact(ctx, draft, actorUserId, requestId) {
    try {
      const result = await runInTenant(ctx, async (tx) => {
        // 1. Insert member
        const insertedMembers = await tx
          .insert(members)
          .values({
            tenantId: draft.member.tenantId,
            memberId: draft.member.memberId,
            companyName: draft.member.companyName,
            legalEntityType: draft.member.legalEntityType,
            country: draft.member.country,
            taxId: draft.member.taxId,
            website: draft.member.website,
            description: draft.member.description,
            foundedYear: draft.member.foundedYear,
            turnoverThb: draft.member.turnoverThb,
            planId: draft.member.planId,
            planYear: draft.member.planYear,
            registrationDate: draft.member.registrationDate
              .toISOString()
              .slice(0, 10),
            registrationFeePaid: draft.member.registrationFeePaid,
            notes: draft.member.notes,
            status: draft.member.status,
            archivedAt: draft.member.archivedAt,
          })
          .returning();
        const memberRow = insertedMembers[0]!;

        // 2. Insert primary contact (bound to the inserted member's id)
        const insertedContacts = await tx
          .insert(contacts)
          .values({
            tenantId: draft.primaryContact.tenantId,
            contactId: draft.primaryContact.contactId,
            memberId: memberRow.memberId,
            firstName: draft.primaryContact.firstName,
            lastName: draft.primaryContact.lastName,
            email: draft.primaryContact.email,
            phone: draft.primaryContact.phone,
            roleTitle: draft.primaryContact.roleTitle,
            preferredLanguage: draft.primaryContact.preferredLanguage,
            isPrimary: true,
            dateOfBirth:
              draft.primaryContact.dateOfBirth?.toISOString().slice(0, 10) ??
              null,
            linkedUserId: draft.primaryContact.linkedUserId,
            removedAt: null,
          })
          .returning();
        const contactRow = insertedContacts[0]!;

        // 3. Audit events (member_created + contact_created) in the SAME tx
        await tx.insert(auditLog).values([
          {
            eventType: 'member_created',
            actorUserId,
            summary: `member_created ${memberRow.companyName}`,
            requestId,
            tenantId: ctx.slug,
            payload: {
              member_id: memberRow.memberId,
              company_name: memberRow.companyName,
              plan_id: memberRow.planId,
              plan_year: memberRow.planYear,
              primary_contact_id: contactRow.contactId,
            },
          },
          {
            eventType: 'contact_created',
            actorUserId,
            summary: `contact_created for member ${memberRow.memberId}`,
            requestId,
            tenantId: ctx.slug,
            payload: {
              member_id: memberRow.memberId,
              contact_id: contactRow.contactId,
              is_primary: true,
            },
          },
        ]);

        return { memberRow, contactRow };
      });

      const persistedMember = rowToMember(result.memberRow);
      const persistedContact: Contact = {
        tenantId: result.contactRow.tenantId as TenantId,
        contactId: result.contactRow.contactId as ContactId,
        memberId: result.contactRow.memberId as MemberId,
        firstName: result.contactRow.firstName,
        lastName: result.contactRow.lastName,
        email: result.contactRow.email as Email,
        phone: result.contactRow.phone as Phone | null,
        roleTitle: result.contactRow.roleTitle,
        preferredLanguage: result.contactRow.preferredLanguage as
          | 'en'
          | 'th'
          | 'sv',
        isPrimary: result.contactRow.isPrimary,
        dateOfBirth: result.contactRow.dateOfBirth
          ? new Date(result.contactRow.dateOfBirth)
          : null,
        linkedUserId: result.contactRow.linkedUserId as UserId | null,
        removedAt: result.contactRow.removedAt,
        createdAt: result.contactRow.createdAt,
        updatedAt: result.contactRow.updatedAt,
      };

      return ok({ member: persistedMember, contact: persistedContact });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/duplicate key|unique constraint/i.test(msg)) {
        return err({ code: 'repo.conflict', reason: 'duplicate' });
      }
      return err(unexpected(e));
    }
  },

  async updateStatus(ctx, memberId, next) {
    try {
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .update(members)
          .set({
            status: next.status,
            archivedAt: next.archivedAt,
            updatedAt: next.updatedAt,
          })
          .where(eq(members.memberId, memberId))
          .returning(),
      );
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToMember(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async updateFields(ctx, memberId, patch) {
    try {
      const rows = await runInTenant(ctx, (tx) =>
        applyMemberPatch(tx, memberId, patch),
      );
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToMember(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async updateFieldsInTx(tx, memberId, patch) {
    try {
      const rows = await applyMemberPatch(tx, memberId, patch);
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToMember(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  // --- Directory search (US2) ------------------------------------------------
  // Substring q across company_name + primary contact name + email.
  // Uses pg_trgm GIN indexes for p95 < 500 ms on ≤5k rows.
  // Cursor is an opaque `last_activity_at|member_id` tuple (base64).
  async searchDirectory(
  ctx: TenantContext,
  filter: DirectoryFilter,
): Promise<
  Result<
    { readonly items: DirectoryRow[]; readonly nextCursor: string | null },
    RepoError
  >
> {
  try {
    const statuses = filter.status ?? ['active', 'inactive'];
    const rows = await runInTenant(ctx, async (tx) => {
      // Build conditions — RLS handles tenant scoping
      const conds = [] as ReturnType<typeof eq>[];
      if (filter.planYear !== undefined)
        conds.push(eq(members.planYear, filter.planYear));
      if (filter.country !== undefined)
        conds.push(eq(members.country, filter.country));
      if (filter.planId !== undefined)
        conds.push(eq(members.planId, filter.planId));

      // Cursor: decode base64 → "<iso>|<memberId>" or "NULL|<memberId>"
      if (filter.cursor) {
        try {
          const decoded = Buffer.from(filter.cursor, 'base64').toString('utf8');
          const [iso, memberIdPart] = decoded.split('|');
          if (memberIdPart) {
            if (iso === 'NULL') {
              // NULL lastActivityAt — compare only by memberId within the
              // NULLS LAST tail segment (DESC ordering).
              conds.push(
                sql`(${members.lastActivityAt} IS NULL AND ${members.memberId} > ${memberIdPart})`,
              );
            } else if (iso) {
              // (last_activity_at, member_id) < (cursorTs, cursorId) — DESC ordering.
              // Cast the ISO string inside SQL so postgres-js doesn't try to
              // serialize a JS Date (driver rejects Date in row-value literals).
              conds.push(
                sql`(${members.lastActivityAt}, ${members.memberId}) < (${iso}::timestamptz, ${memberIdPart})`,
              );
            }
          }
        } catch {
          /* malformed cursor → ignore */
        }
      }

      const whereClause = and(
        or(...statuses.map((s) => eq(members.status, s)))!,
        ...(filter.q
          ? [
              or(
                ilike(members.companyName, `%${filter.q}%`),
                sql`EXISTS (SELECT 1 FROM contacts c
                           WHERE c.tenant_id = ${members.tenantId}
                             AND c.member_id = ${members.memberId}
                             AND c.removed_at IS NULL
                             AND (c.first_name ILIKE ${'%' + filter.q + '%'}
                                  OR c.last_name ILIKE ${'%' + filter.q + '%'}
                                  OR c.email ILIKE ${'%' + filter.q + '%'}))`,
              )!,
            ]
          : []),
        ...conds,
      );

      // Correlated subquery for plan display name — resolved at the DB
      // layer so the directory endpoint serves human-readable plan
      // names without a follow-up listPlans call. Uses the composite
      // PK (tenant_id, plan_id, plan_year) for an index-only lookup.
      // `plan_name` is a JSONB column with shape `{ en: string, th?, sv? }`;
      // we project the English key because it's the canonical display.
      // A tenant-localised lookup can be added later via i18n keys.
      //
      // `mp` is an alias over F2's `membershipPlans` table, imported
      // from `@/modules/plans` (barrel — exposed as a read-only schema
      // reference for sibling-module joins). Drizzle's `alias()` forces
      // both sides of the WHERE to emit table-qualified column
      // references, which avoids the subquery name-resolution trap
      // that plagued the initial raw-SQL version:
      //
      //   without alias (BAD):
      //     interpolation → `mp.tenant_id = "tenant_id"`
      //     → Postgres resolves unqualified "tenant_id" against the
      //       INNER FROM since both tables define it, collapsing the
      //       WHERE to always-true, subquery returns any row.
      //
      //   with alias (GOOD):
      //     `"mp"."tenant_id" = "members"."tenant_id"` on both sides
      //     → unambiguous correlation.
      //
      // Verified by dumping `.toSQL()`. See git log commits 8e71812
      // (root-cause analysis) and the follow-up that introduces this
      // alias pattern + exposes `membershipPlans` from the F2 barrel.
      const mp = alias(membershipPlans, 'mp');
      // Build the subquery via the Drizzle QUERY BUILDER — `.select()
      // .from().where(eq(...))` — because Drizzle only auto-qualifies
      // column references emitted by the builder. Inside a `sql`
      // template the same column objects emit UNQUALIFIED names,
      // collapsing the WHERE to trivially-true when both tables share
      // a column name (see 8e71812 for the full trace).
      const planNameSubquery = tx
        .select({ name: sql<string>`${mp.planName}->>'en'` })
        .from(mp)
        .where(
          and(
            eq(mp.tenantId, members.tenantId),
            eq(mp.planId, members.planId),
            eq(mp.planYear, members.planYear),
          ),
        )
        .limit(1);

      const memberRows = await tx
        .select({
          row: members,
          planDisplayName:
            sql<string | null>`(${planNameSubquery})`.as('plan_display_name'),
        })
        .from(members)
        .where(whereClause)
        .orderBy(
          sql`${members.lastActivityAt} DESC NULLS LAST`,
          asc(members.memberId),
        )
        .limit(filter.limit + 1);

      const page = memberRows.slice(0, filter.limit);

      // Fetch primary contacts in the SAME runInTenant call (single
      // connection setup, consistent snapshot). Uses inArray() instead
      // of or() chain for better query-plan performance.
      const memberIds = page.map((r) => r.row.memberId);
      const primaryContacts =
        memberIds.length === 0
          ? []
          : await tx
              .select()
              .from(contacts)
              .where(
                and(
                  eq(contacts.isPrimary, true),
                  inArray(contacts.memberId, memberIds),
                ),
              );

      return { memberRows, page, primaryContacts };
    });

    const { memberRows, page, primaryContacts } = rows;
    const hasMore = memberRows.length > filter.limit;

    const byMember = new Map<string, (typeof primaryContacts)[number]>();
    for (const c of primaryContacts) {
      if (c.removedAt === null) byMember.set(c.memberId, c);
    }

    const items: DirectoryRow[] = page.map((r) => {
      const m = rowToMember(r.row);
      const c = byMember.get(r.row.memberId) ?? null;
      return {
        member: m,
        planDisplayName: r.planDisplayName,
        primaryContact: c === null ? null : rowToContact(c),
      };
    });

    const nextCursor = hasMore
      ? Buffer.from(
          `${page[page.length - 1]!.row.lastActivityAt?.toISOString() ?? 'NULL'}|${page[page.length - 1]!.row.memberId}`,
        ).toString('base64')
      : null;

    return ok({ items, nextCursor });
  } catch (e) {
    return err(unexpected(e));
  }
  },
};
