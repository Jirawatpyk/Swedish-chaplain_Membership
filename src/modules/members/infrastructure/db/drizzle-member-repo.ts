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

import { and, eq, gt, ilike, inArray, isNull, or, sql, asc, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { err, ok, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { mapDbError, unexpected } from './_repo-error';
import type { TenantContext } from '@/modules/tenants';
import { membershipPlans } from '@/modules/plans';
// MIGRATION 0017 SECURITY CONTRACT — chamber_app can SELECT only:
//   • invitations.user_id
//   • invitations.consumed_at
//   • invitations.expires_at
// The `id` column IS the raw 7-day invite token + `created_at` is
// owner-role only. Adding either to ANY `.select({...})` in this file
// triggers Postgres 42501 (insufficient_privilege) at runtime with no
// TypeScript guard. See `findPendingInvitationsForMember` below for
// the canonical example; the C6 regression that surfaced "Could not
// load pending invitations" in dev was caused by ignoring this rule.
import { invitations } from '@/modules/auth/infrastructure/db/schema';
import { members, type MemberRow } from './schema-members';
import { contacts } from './schema-contacts';
import { rowToContact } from './drizzle-contact-repo';
import type {
  DirectoryFilter,
  DirectoryRow,
  MemberPatch,
  MemberRepo,
  RepoError,
} from '../../application/ports/member-repo';
import {
  memberLifecycle,
  type Member,
  type MemberId,
  type TenantId,
  type PlanId,
} from '../../domain/member';
import type { ContactId } from '../../domain/contact';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import type { TaxId } from '../../domain/value-objects/tax-id';
import type { Email } from '../../domain/value-objects/email';

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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // M5: narrow into the correlated lifecycle union (status ⟺ archivedAt).
    ...memberLifecycle(row.status, row.archivedAt),
  };
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

// --- Directory-search shared builders (P1.2) --------------------------------
// `searchDirectory` (cursor) and `searchDirectoryWithCount` (offset+count)
// previously duplicated these SQL fragments verbatim. Extracted so the
// q-filter EXISTS subquery and the `alias()` plan-name subquery (whose gotcha
// is documented below) live in ONE place. The status OR-set + the `and(...)`
// assembly stay inline in each caller (they differ — cursor vs offset — and
// keeping them inline guarantees byte-identical WHERE composition).

type RepoTx = Parameters<Parameters<typeof runInTenant>[1]>[0];

/**
 * Scalar directory filters (planYear / country / planId / riskBand). Returns
 * `SQL[]` (not `ReturnType<typeof eq>[]`) because the cursor caller also pushes
 * raw `sql\`...\`` predicates onto the returned array.
 */
function buildDirectoryConds(filter: DirectoryFilter): SQL[] {
  const conds: SQL[] = [];
  if (filter.planYear !== undefined)
    conds.push(eq(members.planYear, filter.planYear));
  if (filter.country !== undefined)
    conds.push(eq(members.country, filter.country));
  if (filter.planId !== undefined)
    conds.push(eq(members.planId, filter.planId));
  // I1 round-10 ui-design-specialist — filter by F8-derived risk_score_band.
  // Members with `null` band (not yet scored) are excluded when active
  // (eq() over the nullable column matches only rows with the exact value).
  if (filter.riskBand !== undefined)
    conds.push(eq(members.riskScoreBand, filter.riskBand));
  return conds;
}

/** Substring `q` across company_name + non-removed primary-contact name/email. */
function directoryQFilter(q: string) {
  // Escape LIKE metacharacters (% _ \) so a literal `_`/`%` in the term matches
  // literally instead of acting as a wildcard (e.g. searching `john_doe` must
  // not match `johnXdoe`). Postgres ILIKE's default escape char is backslash.
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  return or(
    ilike(members.companyName, like),
    sql`EXISTS (SELECT 1 FROM contacts c
               WHERE c.tenant_id = ${members.tenantId}
                 AND c.member_id = ${members.memberId}
                 AND c.removed_at IS NULL
                 AND (c.first_name ILIKE ${like}
                      OR c.last_name ILIKE ${like}
                      OR c.email ILIKE ${like}))`,
  )!;
}

/**
 * Correlated plan-display-name subquery. The `alias()` over `membershipPlans`
 * forces table-qualified column refs on BOTH sides of the WHERE, which avoids
 * the subquery name-resolution trap (unqualified `tenant_id` resolving against
 * the inner FROM, collapsing the WHERE to always-true). Built via the query
 * builder — NOT a `sql` template — because Drizzle only auto-qualifies columns
 * emitted by the builder. See git 8e71812 for the full trace.
 */
function directoryPlanNameSubquery(tx: RepoTx) {
  const mp = alias(membershipPlans, 'mp');
  return tx
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
}

/** Map a `{ row, planDisplayName }` page row → DirectoryRow. */
function mapDirectoryRow(
  r: { row: typeof members.$inferSelect; planDisplayName: string | null },
  byMember: Map<string, typeof contacts.$inferSelect>,
): DirectoryRow {
  const c = byMember.get(r.row.memberId) ?? null;
  return {
    member: rowToMember(r.row),
    planDisplayName: r.planDisplayName,
    primaryContact: c === null ? null : rowToContact(c),
    // F8 Phase 6 Wave H — risk_score + band from F3 members schema (populated
    // by F8's batched recompute cron). Null when recompute hasn't run yet
    // (FR-035 min-tenure skips fresh members).
    riskScore: r.row.riskScore ?? null,
    riskScoreBand:
      (r.row.riskScoreBand as DirectoryRow['riskScoreBand']) ?? null,
  };
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

  async findByIdInTx(tx, memberId) {
    try {
      // SELECT ... FOR UPDATE — row-level lock within the ambient tx so
      // concurrent actors must wait. Prevents TOCTOU lost-update (round-3
      // review N-C1). The lock is released on COMMIT / ROLLBACK.
      const rows = await tx
        .select()
        .from(members)
        .where(eq(members.memberId, memberId))
        .for('update')
        .limit(1);
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToMember(rows[0]!));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findManyByIdsInTx(tx, memberIds) {
    try {
      if (memberIds.length === 0) {
        return ok(new Map() as ReadonlyMap<MemberId, Member>);
      }
      // Staff-review SB-1 + SW-1: one batched SELECT with ANY($1) FOR UPDATE
      // replaces the N serial findById calls that previously held a
      // transaction open for ~300 RTT on a 100-row bulk. Each returned
      // row still carries a row-level lock until COMMIT / ROLLBACK.
      const rows = await tx
        .select()
        .from(members)
        .where(inArray(members.memberId, [...memberIds] as string[]))
        .for('update');
      const result = new Map<MemberId, Member>();
      for (const row of rows) {
        const member = rowToMember(row);
        result.set(member.memberId, member);
      }
      return ok(result);
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findByLinkedUserId(ctx, userId) {
    try {
      // Join contacts → members to find the member whose contact has
      // linked_user_id = userId and removed_at IS NULL (US5 portal).
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select({ member: members })
          .from(members)
          .innerJoin(
            contacts,
            and(
              eq(contacts.memberId, members.memberId),
              eq(contacts.tenantId, members.tenantId),
            ),
          )
          .where(
            and(
              eq(contacts.linkedUserId, userId),
              sql`${contacts.removedAt} IS NULL`,
            ),
          )
          .limit(1),
      );
      if (rows.length === 0) return err({ code: 'repo.not_found' });
      return ok(rowToMember(rows[0]!.member));
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

  async createWithPrimaryContactInTx(tx, draft) {
    try {
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

      const result = { memberRow, contactRow };

      const persistedMember = rowToMember(result.memberRow);
      // Reuse the canonical row→Contact mapper (handles the M5 primacy union
      // narrowing) instead of duplicating the field-by-field literal.
      const persistedContact = rowToContact(result.contactRow);

      return ok({ member: persistedMember, contact: persistedContact });
    } catch (e) {
      return err(mapDbError(e, 'duplicate'));
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

  async updateStatusInTx(tx, memberId, next) {
    try {
      const rows = await tx
        .update(members)
        .set({
          status: next.status,
          archivedAt: next.archivedAt,
          updatedAt: next.updatedAt,
        })
        .where(eq(members.memberId, memberId))
        .returning();
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
      // Scalar filters (RLS handles tenant scoping); cursor predicate appended below.
      const conds = buildDirectoryConds(filter);

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
              // Keyset for the MIXED-direction ORDER BY (last_activity_at DESC,
              // member_id ASC): continue with rows whose last_activity_at is
              // strictly older, OR — for rows tied on last_activity_at — whose
              // member_id is GREATER (ASC tie-break). A plain row-value
              // `(a,b) < (x,y)` would compare member_id with `<`, which
              // contradicts the ASC tie-break and silently drops tied rows with
              // member_id > cursorId across the page boundary. Cast the ISO
              // string inside SQL so postgres-js doesn't serialize a JS Date.
              conds.push(
                sql`(${members.lastActivityAt} < ${iso}::timestamptz OR (${members.lastActivityAt} = ${iso}::timestamptz AND ${members.memberId} > ${memberIdPart}))`,
              );
            }
          }
        } catch {
          /* malformed cursor → ignore */
        }
      }

      const whereClause = and(
        or(...statuses.map((s) => eq(members.status, s)))!,
        ...(filter.q ? [directoryQFilter(filter.q)] : []),
        ...conds,
      );

      const planNameSubquery = directoryPlanNameSubquery(tx);

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

    const items: DirectoryRow[] = page.map((r) => mapDirectoryRow(r, byMember));

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

  // --- Offset-paginated directory search with total count ------------------
  // Powers numbered pagination on /admin/members. Runs two queries in one
  // runInTenant transaction: COUNT(*) for the total + LIMIT/OFFSET page.
  // Both use identical WHERE clauses so the count is always consistent
  // with what the page shows (same RLS-scoped snapshot).
  async searchDirectoryWithCount(ctx, filter) {
    try {
      const statuses = filter.status ?? ['active', 'inactive'];
      const result = await runInTenant(ctx, async (tx) => {
        const conds = buildDirectoryConds(filter);

        const whereClause = and(
          or(...statuses.map((s) => eq(members.status, s)))!,
          ...(filter.q ? [directoryQFilter(filter.q)] : []),
          ...conds,
        );

        // Count query — same filters, tenant-scoped via RLS
        const countRows = await tx
          .select({ n: sql<number>`count(*)::int` })
          .from(members)
          .where(whereClause);
        const total = countRows[0]?.n ?? 0;

        const planNameSubquery = directoryPlanNameSubquery(tx);

        // FR-007a engagement sort: engagement = 100 − risk, so engagement DESC
        // (healthiest first, default) = risk ASC; engagement ASC = risk DESC.
        // Unscored (null risk) always sorts last; member_id breaks ties.
        const orderBy =
          filter.sort === 'engagement'
            ? [
                filter.order === 'asc'
                  ? sql`${members.riskScore} DESC NULLS LAST`
                  : sql`${members.riskScore} ASC NULLS LAST`,
                asc(members.memberId),
              ]
            : [sql`${members.lastActivityAt} DESC NULLS LAST`, asc(members.memberId)];

        const memberRows = await tx
          .select({
            row: members,
            planDisplayName:
              sql<string | null>`(${planNameSubquery})`.as('plan_display_name'),
          })
          .from(members)
          .where(whereClause)
          .orderBy(...orderBy)
          .limit(filter.limit)
          .offset(Math.max(0, filter.offset));

        const memberIds = memberRows.map((r) => r.row.memberId);
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

        return { memberRows, primaryContacts, total };
      });

      const byMember = new Map<
        string,
        (typeof result.primaryContacts)[number]
      >();
      for (const c of result.primaryContacts) {
        if (c.removedAt === null) byMember.set(c.memberId, c);
      }

      const items: DirectoryRow[] = result.memberRows.map((r) =>
        mapDirectoryRow(r, byMember),
      );

      return ok({ items, total: result.total });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  // ===========================================================================
  // F7 Batch C extensions (T029) — segment resolution + halt/ack flag I/O
  // ===========================================================================

  async findMembersBySegmentForBroadcast(ctx, params) {
    try {
      const rows = await runInTenant(ctx, async (tx) => {
        // Tier filter via raw SQL to bypass Drizzle's narrow `inArray`
        // type constraint on the `planCategory` enum (only 'corporate' /
        // 'partnership' literals are accepted; F7's `tierCodes` is
        // unconstrained string[] from the F2 plan benefit-matrix). The
        // raw fragment uses parameterised binds so SQL injection is not
        // a concern even though the input is unconstrained.
        const tierCodesArr = params.tierCodes ?? [];
        const tierFilter =
          params.segmentType === 'tier' && tierCodesArr.length > 0
            ? sql`${membershipPlans.planCategory}::text = ANY(ARRAY[${sql.join(
                tierCodesArr.map((c) => sql`${c}`),
                sql`, `,
              )}]::text[])`
            : undefined;
        return tx
          .select({
            memberId: members.memberId,
            companyName: members.companyName,
            primaryEmail: contacts.email,
            planCategory: membershipPlans.planCategory,
            broadcastsHaltedUntilAdminReview:
              members.broadcastsHaltedUntilAdminReview,
          })
          .from(members)
          .leftJoin(
            contacts,
            and(
              eq(contacts.memberId, members.memberId),
              eq(contacts.isPrimary, true),
              sql`${contacts.removedAt} IS NULL`,
            ),
          )
          .leftJoin(
            membershipPlans,
            and(
              eq(membershipPlans.tenantId, members.tenantId),
              eq(membershipPlans.planId, members.planId),
              eq(membershipPlans.planYear, members.planYear),
            ),
          )
          .where(
            tierFilter
              ? and(
                  eq(members.broadcastsHaltedUntilAdminReview, false),
                  tierFilter,
                )
              : eq(members.broadcastsHaltedUntilAdminReview, false),
          )
          .limit(5000);
      });

      return ok(
        rows.map((r) => ({
          memberId: r.memberId as MemberId,
          displayName: r.companyName,
          primaryContactEmail: r.primaryEmail,
          tierCode: r.planCategory,
          broadcastsHaltedUntilAdminReview: r.broadcastsHaltedUntilAdminReview,
        })),
      );
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findMembersHaltedForBroadcast(ctx) {
    try {
      const rows = await runInTenant(ctx, async (tx) =>
        tx
          .select({
            memberId: members.memberId,
            companyName: members.companyName,
            updatedAt: members.updatedAt,
          })
          .from(members)
          .where(eq(members.broadcastsHaltedUntilAdminReview, true)),
      );
      return ok(
        rows.map((r) => ({
          memberId: r.memberId as MemberId,
          displayName: r.companyName,
          haltedSinceAt: r.updatedAt,
        })),
      );
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async updateBroadcastsHaltedInTx(tx, memberId, halted) {
    try {
      const result = await tx
        .update(members)
        .set({
          broadcastsHaltedUntilAdminReview: halted,
          updatedAt: new Date(),
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      return ok({ affected: result.length });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async updateBroadcastsAcknowledgedAtInTx(tx, memberId, timestamp) {
    try {
      // Atomic single-statement: UPDATE ... WHERE broadcasts_acknowledged_at IS NULL
      // produces exactly one fresh-acknowledgement row per concurrent
      // call (the other call's WHERE clause no longer matches). Avoids
      // the read-then-write race where two callers both observe `null`
      // and both report `previouslyNull=true` (would emit duplicate
      // `member_acknowledged_broadcasts_terms` audits).
      const freshRows = await tx
        .update(members)
        .set({
          broadcastsAcknowledgedAt: timestamp,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(members.memberId, memberId),
            sql`${members.broadcastsAcknowledgedAt} IS NULL`,
          ),
        )
        .returning({ memberId: members.memberId });

      if (freshRows.length === 1) {
        return ok({ affected: 1, previouslyNull: true });
      }

      // No fresh transition — either the member doesn't exist, or
      // they're already acked. Probe to discriminate so the caller can
      // 404 vs return idempotent-ok. Preserve the original consent
      // timestamp on re-ack (GDPR Art. 7 demonstrable consent — the
      // first acknowledgement is the legal anchor; later clicks are
      // re-affirmations and don't reset the column).
      const existsRows = await tx
        .select({ memberId: members.memberId })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      if (existsRows.length === 0) {
        return ok({ affected: 0, previouslyNull: false });
      }
      return ok({ affected: 1, previouslyNull: false });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findPrimaryContactEmailInTx(tx, memberId) {
    try {
      const rows = await tx
        .select({ email: contacts.email })
        .from(contacts)
        .where(
          and(
            eq(contacts.memberId, memberId),
            eq(contacts.isPrimary, true),
            sql`${contacts.removedAt} IS NULL`,
          ),
        )
        .limit(1);
      const row = rows[0];
      return ok(row ? row.email : null);
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findPreferredLocaleInTx(tx, memberId) {
    try {
      const rows = await tx
        .select({ locale: members.preferredLocale })
        .from(members)
        .where(eq(members.memberId, memberId))
        .limit(1);
      const row = rows[0];
      // CHECK constraint guarantees stored value is one of en|th|sv
      // (or null). Cast safe — defensive runtime check below catches
      // any direct-INSERT bypass.
      const v = row?.locale ?? null;
      if (v === null || v === 'en' || v === 'th' || v === 'sv') {
        return ok(v);
      }
      return ok(null);
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async updatePreferredLocaleInTx(tx, memberId, nextLocale) {
    try {
      const rows = await tx
        .update(members)
        .set({ preferredLocale: nextLocale, updatedAt: new Date() })
        .where(eq(members.memberId, memberId))
        .returning({ previousValue: members.preferredLocale });
      const affected = rows.length;
      if (affected === 0) {
        return ok({ affected: 0, previousValue: null });
      }
      // `previousValue` echoes `nextLocale` (RETURNING yields the POST-update
      // value) and is intentionally unused by callers — see port doc. The
      // use-case loads the prior value via `findPreferredLocaleInTx`.
      return ok({ affected, previousValue: nextLocale });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findMemberByPrimaryContactEmailInTx(tx, emailLower) {
    try {
      const rows = await tx
        .select({
          memberId: members.memberId,
          companyName: members.companyName,
          email: contacts.email,
          planCategory: membershipPlans.planCategory,
          broadcastsHaltedUntilAdminReview:
            members.broadcastsHaltedUntilAdminReview,
        })
        .from(members)
        .innerJoin(
          contacts,
          and(
            eq(contacts.memberId, members.memberId),
            eq(contacts.isPrimary, true),
            sql`${contacts.removedAt} IS NULL`,
            sql`lower(${contacts.email}) = ${emailLower}`,
          ),
        )
        .leftJoin(
          membershipPlans,
          and(
            eq(membershipPlans.tenantId, members.tenantId),
            eq(membershipPlans.planId, members.planId),
            eq(membershipPlans.planYear, members.planYear),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (!row) return ok(null);
      return ok({
        memberId: row.memberId as MemberId,
        displayName: row.companyName,
        primaryContactEmail: row.email,
        tierCode: row.planCategory,
        broadcastsHaltedUntilAdminReview: row.broadcastsHaltedUntilAdminReview,
      });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findLastPlanChangedAt(
    ctx: TenantContext,
    memberId: MemberId,
  ): Promise<Result<Date | null, RepoError>> {
    try {
      const rows = await runInTenant(ctx, async (tx) =>
        tx.execute(sql`
          SELECT "timestamp" AS changed_at
            FROM audit_log
           WHERE tenant_id = ${ctx.slug}
             AND event_type = 'member_plan_changed'
             AND payload ->> 'member_id' = ${memberId as string}
           ORDER BY "timestamp" DESC, id DESC
           LIMIT 1
        `),
      );
      const arr = rows as unknown as Array<{ changed_at: Date | null }>;
      const row = arr[0];
      if (!row || row.changed_at == null) return ok(null);
      return ok(new Date(row.changed_at));
    } catch (e) {
      return err(unexpected(e));
    }
  },

  /**
   * C6 round-10 ui-design-specialist — pending portal invitations for
   * this member's contacts. Cross-schema Drizzle join (auth.invitations
   * × members.contacts via contacts.linked_user_id = invitations.user_id).
   *
   * Tenant scope: `contacts` RLS scopes the join under runInTenant +
   * chamber_app role. `invitations` is cross-tenant by design (a user
   * holds tenant-agnostic invites), so the join via contacts is what
   * enforces the boundary. The `contacts.removed_at IS NULL` filter
   * hides invitations for archived/removed contacts.
   *
   * Column visibility (migration 0017, staff-review R001):
   * `chamber_app` sees only `invitations.user_id`,
   * `invitations.consumed_at`, `invitations.expires_at`. The `id`
   * (raw 7-day token) and `created_at` are owner-role only — selecting
   * either returns Postgres 42501 (permission denied). The SELECT
   * list below sticks to the allowed 3 columns; the UI keys the
   * inline badge off `contactId` rather than `invitationId`, and
   * sorts by `expiresAt ASC` (soonest-to-expire first) since we can't
   * sort by `createdAt`.
   *
   * "Pending" = `consumed_at IS NULL AND expires_at > NOW()`. LIMIT 50
   * caps pathological cases.
   */
  async findPendingInvitationsForMember(ctx, memberId) {
    try {
      const rows = await runInTenant(ctx, async (tx) =>
        tx
          .select({
            expiresAt: invitations.expiresAt,
            contactId: contacts.contactId,
            firstName: contacts.firstName,
            lastName: contacts.lastName,
            email: contacts.email,
          })
          .from(invitations)
          .innerJoin(
            contacts,
            eq(contacts.linkedUserId, invitations.userId),
          )
          .where(
            and(
              eq(contacts.memberId, memberId),
              isNull(contacts.removedAt),
              isNull(invitations.consumedAt),
              gt(invitations.expiresAt, sql`NOW()`),
            ),
          )
          .orderBy(asc(invitations.expiresAt))
          .limit(50),
      );
      return ok(
        rows.map((r) => ({
          contactId: r.contactId as ContactId,
          contactFirstName: r.firstName,
          contactLastName: r.lastName,
          contactEmail: r.email as Email,
          expiresAt: r.expiresAt,
        })),
      );
    } catch (e) {
      return err(unexpected(e));
    }
  },
};
