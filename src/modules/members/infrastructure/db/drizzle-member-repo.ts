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

import { and, eq, ilike, or, sql, asc } from 'drizzle-orm';
import { err, ok, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { members, type MemberRow } from './schema-members';
import { contacts } from './schema-contacts';
import { auditLog } from '@/modules/auth/infrastructure/db/schema';
import type { MemberRepo, RepoError } from '../../application/ports/member-repo';
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
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select()
          .from(members)
          .where(
            and(
              ilike(members.companyName, companyName),
              eq(members.country, country),
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
        tx
          .update(members)
          .set({
            ...(patch.companyName !== undefined && {
              companyName: patch.companyName,
            }),
            ...(patch.legalEntityType !== undefined && {
              legalEntityType: patch.legalEntityType,
            }),
            ...(patch.website !== undefined && { website: patch.website }),
            ...(patch.description !== undefined && {
              description: patch.description,
            }),
            ...(patch.notes !== undefined && { notes: patch.notes }),
            ...(patch.taxId !== undefined && { taxId: patch.taxId }),
            ...(patch.turnoverThb !== undefined && {
              turnoverThb: patch.turnoverThb,
            }),
            ...(patch.foundedYear !== undefined && {
              foundedYear: patch.foundedYear,
            }),
            updatedAt: new Date(),
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
};

// --- Directory search (US2) --------------------------------------------------

export type DirectoryFilter = {
  readonly q?: string;
  readonly status?: readonly ('active' | 'inactive' | 'archived')[];
  readonly planYear?: number;
  readonly country?: string;
  readonly planId?: string;
  readonly limit: number;
  readonly cursor?: string;
};

export type DirectoryRow = {
  readonly member: Member;
  readonly primaryContact: Contact | null;
  /**
   * English display name of the plan resolved via a correlated subquery
   * on `membership_plans.plan_name->>'en'`. Denormalized into every row
   * so the UI doesn't need a second listPlans fetch to map slug →
   * human name — saves the N+1 round-trip and keeps the module
   * boundary clean (no schema import from `@/modules/plans`).
   * `null` when the plan row has been deleted (should not happen for
   * active members but defensive fallback shows the slug).
   */
  readonly planDisplayName: string | null;
};

/**
 * Directory search — substring q across company_name + primary contact
 * name + email. Uses pg_trgm GIN indexes for p95 < 500 ms on ≤5k rows.
 * Cursor is an opaque `last_activity_at|member_id` tuple (base64) so
 * pagination remains stable across inserts.
 */
export async function searchDirectory(
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

      // Cursor: decode base64 → "<iso>|<memberId>"
      if (filter.cursor) {
        try {
          const decoded = Buffer.from(filter.cursor, 'base64').toString('utf8');
          const [iso, memberIdPart] = decoded.split('|');
          if (iso && memberIdPart) {
            // (last_activity_at, member_id) < (cursorTs, cursorId) — DESC ordering.
            // Cast the ISO string inside SQL so postgres-js doesn't try to
            // serialize a JS Date (driver rejects Date in row-value literals).
            conds.push(
              sql`(${members.lastActivityAt}, ${members.memberId}) < (${iso}::timestamptz, ${memberIdPart})`,
            );
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
      // Raw SQL for the outer-table correlation — Drizzle's sql template
      // interpolation of column objects (`${members.tenantId}`) emitted
      // the OUTER members column references inside the subquery but
      // Postgres appears to resolve them to the INNER membership_plans
      // scope first (both tables share the column names), returning
      // the wrong row. Referring to the outer table by its default
      // double-quoted name pins the comparison to the correlated
      // row unambiguously.
      return tx
        .select({
          row: members,
          planDisplayName: sql<string | null>`(
            SELECT plan_name->>'en' FROM membership_plans AS mp
            WHERE mp.tenant_id = "members"."tenant_id"
              AND mp.plan_id   = "members"."plan_id"
              AND mp.plan_year = "members"."plan_year"
            LIMIT 1
          )`.as('plan_display_name'),
        })
        .from(members)
        .where(whereClause)
        .orderBy(
          sql`${members.lastActivityAt} DESC NULLS LAST`,
          asc(members.memberId),
        )
        .limit(filter.limit + 1);
    });

    const page = rows.slice(0, filter.limit);
    const hasMore = rows.length > filter.limit;

    // Fetch primary contacts in one query (N+1 guard)
    const memberIds = page.map((r) => r.row.memberId);
    const primaryContacts =
      memberIds.length === 0
        ? []
        : await runInTenant(ctx, (tx) =>
            tx
              .select()
              .from(contacts)
              .where(
                and(
                  eq(contacts.isPrimary, true),
                  or(...memberIds.map((id) => eq(contacts.memberId, id)))!,
                ),
              ),
          );
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
        primaryContact:
          c === null
            ? null
            : {
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
              },
      };
    });

    const nextCursor = hasMore
      ? Buffer.from(
          `${page[page.length - 1]!.row.lastActivityAt?.toISOString() ?? ''}|${page[page.length - 1]!.row.memberId}`,
        ).toString('base64')
      : null;

    return ok({ items, nextCursor });
  } catch (e) {
    return err(unexpected(e));
  }
}
