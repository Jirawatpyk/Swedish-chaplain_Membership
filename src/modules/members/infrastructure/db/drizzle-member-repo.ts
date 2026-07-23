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

import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  notExists,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
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
  DirectoryOffsetFilter,
  DirectoryRow,
  MemberPatch,
  MemberRepo,
  RepoError,
  RiskBand,
} from '../../application/ports/member-repo';
import {
  memberLifecycle,
  type Member,
  type MemberId,
  type TenantId,
  type PlanId,
} from '../../domain/member';
import type { Contact, ContactId } from '../../domain/contact';
import { ERASED_SENTINEL } from '../../domain/erasure-sentinels';
import type { IsoCountryCode } from '../../domain/value-objects/iso-country-code';
import { isLegalEntityTypeCode } from '../../domain/value-objects/legal-entity-type';
import type { TaxId } from '../../domain/value-objects/tax-id';
import type { Email } from '../../domain/value-objects/email';
import { asMemberNumber, parseMemberNumberQuery } from '../../domain/value-objects/member-number';

// --- Row → Domain ------------------------------------------------------------

function rowToMember(row: MemberRow): Member {
  return {
    tenantId: row.tenantId as TenantId,
    memberId: row.memberId as MemberId,
    // 055-member-number — column is NOT NULL post-backfill (migration 0209).
    // asMemberNumber throws InvalidMemberNumberError on a <= 0 / non-integer
    // value: a loud backstop if a direct-INSERT bypass ever writes a bad row.
    memberNumber: asMemberNumber(row.memberNumber),
    companyName: row.companyName,
    // Review fix (Finding 1) — the DB column is a plain `text` (never
    // migrated to an enum; the catalogue is application-layer only), so a
    // row is `string | null` at read time. A row written BEFORE Task 3b's
    // closure (or via any future bypass) may hold an out-of-catalogue
    // value. Rather than `as LegalEntityTypeCode` (which would silently
    // masquerade a bad value as a valid code) or throwing (which would
    // crash the member page on a legacy row), an unrecognised value reads
    // as `null` here. This DOES change what a legacy out-of-catalogue row
    // renders as: `resolveLegalEntityTypeLabel` (presentation layer) is
    // called with `member.legalEntityType` from THIS function at every
    // read site (admin detail page, portal profile page, the admin API's
    // `_serialise.ts`) — none of them read the raw column independently —
    // so such a row now shows "not recorded" instead of the raw stored
    // string. Accepted: `members` is EMPTY in production (wiped
    // 2026-07-12), so no such row exists today; a HONEST, non-crashing
    // `null` beats a silently-mistyped value.
    legalEntityType: isLegalEntityTypeCode(row.legalEntityType)
      ? row.legalEntityType
      : null,
    country: row.country as IsoCountryCode,
    taxId: row.taxId as TaxId | null,
    // 088 US3 — §86/4 Head-Office / Branch particular. Always populated from the
    // DB (NOT NULL flag + nullable char(5) code); the optional interface fields
    // are for hand-built drafts/fixtures, not for a loaded row.
    isHeadOffice: row.isHeadOffice,
    branchCode: row.branchCode,
    isVatRegistered: row.isVatRegistered,
    // 065 §5.1 — per-member billing cadence. Always populated from the NOT NULL
    // column (DB DEFAULT 'rolling'); the optional aggregate field is for
    // hand-built drafts/fixtures, not for a loaded row.
    billingCycle: row.billingCycle,
    website: row.website,
    description: row.description,
    foundedYear: row.foundedYear,
    turnoverThb: row.turnoverThb,
    registeredCapitalThb: row.registeredCapitalThb,
    planId: row.planId as PlanId,
    planYear: row.planYear,
    registrationDate: new Date(row.registrationDate),
    registrationFeePaid: row.registrationFeePaid,
    lastActivityAt: row.lastActivityAt,
    notes: row.notes,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    province: row.province,
    postalCode: row.postalCode,
    subDistrict: row.subDistrict,
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
  // 088 US3 — §86/4 branch particular. The `members_branch_pairing_ck` DB CHECK
  // is the backstop (head office ⇒ NULL code; branch ⇒ 5 digits); the caller
  // (updateMember zod superRefine + the admin form) sends a CHECK-consistent pair.
  if (patch.isHeadOffice !== undefined) set.isHeadOffice = patch.isHeadOffice;
  if (patch.branchCode !== undefined) set.branchCode = patch.branchCode;
  if (patch.isVatRegistered !== undefined) set.isVatRegistered = patch.isVatRegistered;
  // 065 §5.1 — per-member billing cadence (admin-managed edit).
  if (patch.billingCycle !== undefined) set.billingCycle = patch.billingCycle;
  if (patch.website !== undefined) set.website = patch.website;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.notes !== undefined) set.notes = patch.notes;
  if (patch.taxId !== undefined) set.taxId = patch.taxId;
  if (patch.turnoverThb !== undefined) set.turnoverThb = patch.turnoverThb;
  if (patch.registeredCapitalThb !== undefined)
    set.registeredCapitalThb = patch.registeredCapitalThb;
  if (patch.foundedYear !== undefined) set.foundedYear = patch.foundedYear;
  if (patch.addressLine1 !== undefined) set.addressLine1 = patch.addressLine1;
  if (patch.addressLine2 !== undefined) set.addressLine2 = patch.addressLine2;
  if (patch.city !== undefined) set.city = patch.city;
  if (patch.province !== undefined) set.province = patch.province;
  if (patch.postalCode !== undefined) set.postalCode = patch.postalCode;
  if (patch.subDistrict !== undefined) set.subDistrict = patch.subDistrict;
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
// is documented below) live in ONE place.

type RepoTx = Parameters<Parameters<typeof runInTenant>[1]>[0];

/**
 * Scalar directory filters (planYear / country / planId / riskBand). Returns
 * `SQL[]` (not `ReturnType<typeof eq>[]`) for a uniform element type across the
 * `eq()` / `inArray()` results. (The cursor path's own pagination predicates are
 * kept in a separate `cursorConds` array by `searchDirectory` and are NOT pushed
 * onto this one — see `buildDirectoryWhere` below.)
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
  if (filter.riskBand !== undefined) {
    // S1-P1-6: accept a single band OR an array (the dashboard "needs
    // attention" KPI drills into all three at-risk bands so the count and the
    // destination list agree). Members with `null` band are excluded either way.
    if (Array.isArray(filter.riskBand)) {
      // go-live #7 — `inArray(col, [])` renders as a constant-FALSE predicate in
      // Drizzle, which would silently return ZERO rows. Treat an empty band array
      // as "no risk-band filter" (push nothing) rather than "match nothing".
      if (filter.riskBand.length > 0) {
        conds.push(inArray(members.riskScoreBand, [...filter.riskBand]));
      }
    } else {
      conds.push(eq(members.riskScoreBand, filter.riskBand as RiskBand));
    }
  }
  return conds;
}

/**
 * The complete directory WHERE clause, shared by every caller that must agree
 * on "which members are in the directory": the cursor search, the offset
 * search + its COUNT, and the needs-invite chip count. Previously the erased
 * exclusion, status OR-set and q-filter were hand-assembled per caller; a
 * third caller made that a drift risk with a GDPR-shaped failure mode (a
 * count that includes erased tombstones).
 */
function buildDirectoryWhere(
  filter: DirectoryFilter | DirectoryOffsetFilter,
): SQL {
  const statuses = filter.status ?? ['active', 'inactive'];
  return and(
    // COMP-1 H4 — erasure keeps `status` and stamps only `erased_at`, so the
    // status OR-set does NOT hide an erased row.
    isNull(members.erasedAt),
    or(...statuses.map((s) => eq(members.status, s)))!,
    ...(filter.q ? [directoryQFilter(filter.q)] : []),
    ...buildDirectoryConds(filter),
  )!;
}

/** Substring `q` across company_name + non-removed primary-contact name/email,
 *  plus an exact member-number match when `q` parses to a positive integer
 *  (`SCCM-0042` / `0042` / `42`). The integer branch uses the
 *  `members_tenant_member_number_uniq` index. */
function directoryQFilter(q: string) {
  // Escape LIKE metacharacters (% _ \) so a literal `_`/`%` in the term matches
  // literally instead of acting as a wildcard (e.g. searching `john_doe` must
  // not match `johnXdoe`). Postgres ILIKE's default escape char is backslash.
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const num = parseMemberNumberQuery(q);
  return or(
    ilike(members.companyName, like),
    sql`EXISTS (SELECT 1 FROM contacts c
               WHERE c.tenant_id = ${members.tenantId}
                 AND c.member_id = ${members.memberId}
                 AND c.removed_at IS NULL
                 AND (c.first_name ILIKE ${like}
                      OR c.last_name ILIKE ${like}
                      OR c.email ILIKE ${like}))`,
    ...(num !== null ? [eq(members.memberNumber, num)] : []),
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

/**
 * PR-B task 8 — insert one `contacts` row on the given tx, factored out of
 * `createWithPrimaryContactInTx` so the primary and secondary contact
 * inserts share the exact same column mapping (only `isPrimary` differs).
 * Callers wrap this in their OWN try/catch so a unique-violation on the
 * primary insert vs the secondary insert maps to a DISTINCT
 * `RepoConflictReason` — see the port doc.
 */
async function insertContactRow(
  tx: RepoTx,
  memberId: string,
  contact: Omit<Contact, 'createdAt' | 'updatedAt' | 'memberId'>,
  isPrimary: boolean,
) {
  const inserted = await tx
    .insert(contacts)
    .values({
      tenantId: contact.tenantId,
      contactId: contact.contactId,
      memberId,
      firstName: contact.firstName,
      lastName: contact.lastName,
      email: contact.email,
      phone: contact.phone,
      roleTitle: contact.roleTitle,
      preferredLanguage: contact.preferredLanguage,
      isPrimary,
      dateOfBirth: contact.dateOfBirth?.toISOString().slice(0, 10) ?? null,
      linkedUserId: contact.linkedUserId,
      art14AttestedAt: contact.art14AttestedAt,
      removedAt: null,
    })
    .returning();
  return inserted[0]!;
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

  async findRiskById(ctx, memberId) {
    try {
      // Narrow 2-column read (B18). Threads the runInTenant tx (RLS gotcha) —
      // never the global db. Cross-tenant / absent → not_found via RLS.
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select({
            riskScore: members.riskScore,
            riskScoreBand: members.riskScoreBand,
          })
          .from(members)
          .where(eq(members.memberId, memberId))
          .limit(1),
      );
      const row = rows[0];
      if (row === undefined) return err({ code: 'repo.not_found' });
      return ok({
        riskScore: row.riskScore ?? null,
        riskScoreBand: (row.riskScoreBand as RiskBand | null) ?? null,
      });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findErasedAtById(ctx, memberId) {
    try {
      // COMP-1 narrow 1-column read (erasure pre-flight). Threads the
      // runInTenant tx (RLS gotcha) — never the global db. Cross-tenant /
      // absent → not_found via RLS. `erased_at` is nullable: a non-erased
      // member returns `{ erasedAt: null }`.
      const rows = await runInTenant(ctx, (tx) =>
        tx
          .select({ erasedAt: members.erasedAt })
          .from(members)
          .where(eq(members.memberId, memberId))
          .limit(1),
      );
      const row = rows[0];
      if (row === undefined) return err({ code: 'repo.not_found' });
      return ok({ erasedAt: row.erasedAt ?? null });
    } catch (e) {
      return err(unexpected(e));
    }
  },

  async findStuckErasuresInTx(tx, tenantSlug, limit) {
    // COMP-1 US2d reconciler candidate query. Anti-join: erased members
    // (erased_at IS NOT NULL) with NO `member_erased` completion audit. The
    // `reason` is resolved from the member's EARLIEST (first)
    // `member_erasure_requested` audit (COALESCE → 'gdpr_erasure_request') — the
    // original Art.17/PDPA §33 reason, matching the insights `earliest()` fold
    // (erasure-evidence.ts) and the Art.12-clock invariant (erase-member.ts:
    // "the earliest timestamp wins ... the conservative direction"). Under the
    // documented concurrent-double-request edge (two `member_erasure_requested`
    // rows with different reasons) the reconciler-emitted member_erased/cascade
    // audits must carry the SAME legal basis the DPO evidence page shows.
    //
    // LOAD-BEARING tenant filter on BOTH audit_log subqueries: audit_log uses
    // a PERMISSIVE RLS policy (migration 0007 — NULL-tenant F1 identity rows are
    // visible to every context), so `al.tenant_id = ${tenantSlug}` is required
    // for correctness, NOT defence-in-depth (mirrors the at-risk-scorer's
    // audit_log subqueries). `members` uses a strict isolating policy — its
    // outer WHERE is RLS-scoped by runInTenant, no explicit filter needed.
    //
    // The string-literal `event_type = 'member_erased'` comparisons are coerced
    // to the `audit_event_type` enum by Postgres (same pattern as
    // `findLastPlanChangedAt` / the audit-log queries elsewhere in this file).
    // `payload->>'member_id'` / `'reason'` are the EXACT snake_case keys the
    // `audit.recordInTx` emit in `erase-member.ts` writes — a key drift here
    // would silently 0-match and strand erasures, which the live integration
    // test guards against.
    //
    // FOR UPDATE OF m SKIP LOCKED locks ONLY the `members` row (audit subqueries
    // aren't lockable) so concurrent reconciler ticks don't double-drive a row.
    // Threads the runInTenant `tx` (RLS gotcha — never the global db).
    const rows = (await tx.execute(sql`
      SELECT m.member_id::text AS member_id,
             COALESCE(
               (SELECT al.payload->>'reason'
                FROM audit_log al
                WHERE al.tenant_id = ${tenantSlug}
                  AND al.event_type = 'member_erasure_requested'
                  AND al.payload->>'member_id' = m.member_id::text
                ORDER BY al."timestamp" ASC LIMIT 1),
               'gdpr_erasure_request'
             ) AS reason
      FROM members m
      WHERE m.erased_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM audit_log al2
          WHERE al2.tenant_id = ${tenantSlug}
            AND al2.event_type = 'member_erased'
            AND al2.payload->>'member_id' = m.member_id::text
        )
      ORDER BY m.erased_at ASC
      LIMIT ${limit}
      FOR UPDATE OF m SKIP LOCKED
    `)) as unknown as Array<{ member_id: string; reason: string }>;
    return rows.map((r) => ({
      memberId: r.member_id as MemberId,
      reason:
        r.reason === 'pdpa_deletion_request'
          ? ('pdpa_deletion_request' as const)
          : ('gdpr_erasure_request' as const),
    }));
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
              // Explicit tenant predicate (defence-in-depth alongside RLS):
              // Constitution Principle I two-layer isolation. `findByLinkedUserId`
              // resolves the member for a session user, so a cross-tenant leak here
              // would be a Principle I violation if RLS were ever misconfigured.
              eq(members.tenantId, ctx.slug),
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
              // COMP-1 H4 — an erased tombstone must not block a legitimate
              // re-registration under the same name.
              isNull(members.erasedAt),
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
    // PR-B task 8 — THREE separate try/catch blocks (member, primary
    // contact, secondary contact), each mapping a unique-violation to its
    // OWN `RepoConflictReason`. The former single try/catch around the
    // whole method could only ever say 'duplicate' regardless of which
    // insert actually collided — a secondary-email collision would report
    // as if the PRIMARY email were taken. All three inserts still run on
    // the SAME `tx` (threaded from the caller's `runInTenant`), so a
    // failure on insert 2 or 3 still rolls back insert 1 — "one
    // transaction, or none" is a property of the CALLER's tx boundary, not
    // of how many try/catch blocks sit inside this method.

    // 1. Insert member
    let memberRow: typeof members.$inferSelect;
    try {
      const insertedMembers = await tx
        .insert(members)
        .values({
          tenantId: draft.member.tenantId,
          memberId: draft.member.memberId,
          // 055-member-number — allocated by createMember inside the same tx.
          memberNumber: draft.member.memberNumber,
          companyName: draft.member.companyName,
          legalEntityType: draft.member.legalEntityType,
          country: draft.member.country,
          taxId: draft.member.taxId,
          isVatRegistered: draft.member.isVatRegistered,
          // 065 §5.1 — per-member billing cadence. `?? 'rolling'` guards a
          // hand-built draft that omits it (matches the DB DEFAULT); the real
          // create path always threads the admin's chosen value.
          billingCycle: draft.member.billingCycle ?? 'rolling',
          website: draft.member.website,
          description: draft.member.description,
          foundedYear: draft.member.foundedYear,
          turnoverThb: draft.member.turnoverThb,
          registeredCapitalThb: draft.member.registeredCapitalThb,
          planId: draft.member.planId,
          planYear: draft.member.planYear,
          registrationDate: draft.member.registrationDate
            .toISOString()
            .slice(0, 10),
          registrationFeePaid: draft.member.registrationFeePaid,
          notes: draft.member.notes,
          addressLine1: draft.member.addressLine1,
          addressLine2: draft.member.addressLine2,
          city: draft.member.city,
          province: draft.member.province,
          postalCode: draft.member.postalCode,
          subDistrict: draft.member.subDistrict,
          status: draft.member.status,
          archivedAt: draft.member.archivedAt,
        })
        .returning();
      memberRow = insertedMembers[0]!;
    } catch (e) {
      return err(mapDbError(e, 'member_duplicate'));
    }

    // 2. Insert primary contact (bound to the inserted member's id)
    let contactRow: typeof contacts.$inferSelect;
    try {
      contactRow = await insertContactRow(
        tx,
        memberRow.memberId,
        draft.primaryContact,
        true,
      );
    } catch (e) {
      return err(mapDbError(e, 'primary_email_in_use'));
    }

    // 3. Insert secondary contact — OPTIONAL (PR-B task 8). isPrimary is
    // always false: `contacts_one_primary_per_member` (a partial unique
    // index) would reject a second isPrimary:true row for this member.
    let secondaryContactRow: typeof contacts.$inferSelect | null = null;
    if (draft.secondaryContact) {
      try {
        secondaryContactRow = await insertContactRow(
          tx,
          memberRow.memberId,
          draft.secondaryContact,
          false,
        );
      } catch (e) {
        return err(mapDbError(e, 'secondary_email_in_use'));
      }
    }

    const persistedMember = rowToMember(memberRow);
    // Reuse the canonical row→Contact mapper (handles the M5 primacy union
    // narrowing) instead of duplicating the field-by-field literal.
    const persistedContact = rowToContact(contactRow);
    const persistedSecondaryContact = secondaryContactRow
      ? rowToContact(secondaryContactRow)
      : null;

    return ok({
      member: persistedMember,
      contact: persistedContact,
      secondaryContact: persistedSecondaryContact,
    });
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

  async scrubPiiInTx(tx, memberId, opts) {
    try {
      // COMP-1 member erasure (GDPR Art.17 / PDPA §33). Anonymise the member
      // row in place. `company_name` is NOT NULL so it takes the non-PII
      // SENTINEL `[erased]`; every other PII-bearing column is NULLed —
      // including the business quasi-identifiers `turnover_thb` + `founded_year`
      // (GDPR Recital 26: at small-chamber scale these are re-identifying) and
      // the F8-era admin free-text + risk cluster: the
      // `blocked_from_auto_reactivation_reason` (admin free-text, same PII class
      // as `notes` — it can name/email the member), the admin who set the block
      // (`..._set_by_user_id`), and the derived behavioural/financial risk
      // signals (`risk_score`/`risk_score_band`/`risk_score_factors` +
      // their computed/snooze timestamps, moot once the score is gone).
      //
      // The blocked-reactivation cluster is erased AS A UNIT. We cannot keep
      // `blocked_from_auto_reactivation = TRUE` after nulling its provenance:
      // the `members_blocked_from_auto_reactivation_consistency_check` CHECK
      // (migration 0094) requires that when the flag is TRUE both `..._at` AND
      // `..._set_by_user_id` are NOT NULL. Erasing the actor (`set_by_user_id`)
      // therefore forces the whole cluster back to the FALSE/NULL branch — the
      // "blocked because admin X said Y" record cannot persist without its
      // provenance, and the flag/`at` carry no value once the reason+actor are
      // gone. So `blocked_from_auto_reactivation` → FALSE and `..._at` → NULL.
      //
      // KEPT: the 2-letter ISO `country` (NOT NULL, low re-identification,
      // useful aggregate), `preferred_locale` (a UX setting), identity
      // (`member_id`, `member_number`, `plan_*`), registration/created dates,
      // `status` (erasure is orthogonal to archive), and the non-identifying
      // state flags + their consent/record-keeping timestamps
      // (renewal-opt-out, email-unverified, broadcasts-halt/ack).
      //
      // The full SCRUBBED ∪ KEPT partition is enforced as an allowlist by
      // `tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts`,
      // which fails the build if a future column is left unclassified — keep
      // this `.set({...})` in lock-step with that test's SCRUBBED set.
      //
      // Tenant-scoped via the caller's runInTenant tx (RLS); no manual
      // tenant_id filter needed. Idempotent: re-running yields the same row.
      const updated = await tx
        .update(members)
        .set({
          companyName: ERASED_SENTINEL,
          legalEntityType: null,
          taxId: null,
          website: null,
          description: null,
          notes: null,
          foundedYear: null,
          turnoverThb: null,
          addressLine1: null,
          addressLine2: null,
          city: null,
          province: null,
          postalCode: null,
          subDistrict: null,
          registeredCapitalThb: null,
          // 088 US3 — reset the §86/4 Head-Office / Branch particular to its
          // head-office DEFAULT on erasure (drops the RD branch identifier). The
          // pair stays CHECK-consistent (`members_branch_pairing_ck`): head
          // office ⇒ NULL branch code.
          isHeadOffice: true,
          branchCode: null,
          // 059 / PR-A — reset the §86/4 VAT-registrant flag to its DEFAULT
          // (false) on erasure, not NULL: the column is NOT NULL, and `false`
          // also keeps the branch-pairing CHECK satisfiable (a non-registrant
          // cannot be a branch).
          isVatRegistered: false,
          // H1 — F8-era admin free-text + derived risk cluster. The blocked-
          // reactivation flag + `..._at` collapse to FALSE/NULL alongside their
          // provenance to satisfy the 0094 consistency CHECK (see comment above).
          blockedFromAutoReactivation: false,
          blockedFromAutoReactivationAt: null,
          blockedFromAutoReactivationReason: null,
          blockedFromAutoReactivationSetByUserId: null,
          riskScore: null,
          riskScoreBand: null,
          riskScoreFactors: null,
          riskScoreLastComputedAt: null,
          riskSnoozedUntil: null,
          // `erased_at` is STICKY — COALESCE preserves the ORIGINAL erasure
          // instant on a US2d reconciler re-drive (erase-member.ts always passes
          // a FRESH `{ erasedAt: now }`). The Art.12/§30 date-of-erasure must not
          // drift forward: member-erasure-evidence-reads.ts paginates keyset on
          // this column (a drifting value silently skips/duplicates a re-driven
          // member between "load more" fetches) and findStuckErasuresInTx
          // ORDER BYs it (a drift re-sorts the row to the back of the reconciler
          // queue each tick). Every PII column above stays UNCONDITIONAL so the
          // re-drive still defensively re-applies anonymisation, and `updated_at`
          // (a generic mutation marker no consumer paginates on) DOES advance to
          // record the re-write. The WHERE stays member-id-only — the re-drive
          // must still re-scrub PII even when erased_at is already set, so NO
          // `WHERE erased_at IS NULL` guard.
          //
          // The fresh instant is bound as an ISO string cast to `timestamptz`:
          // a raw `sql` placeholder hands the parameter straight to the postgres
          // driver, which rejects a JS `Date` for an untyped placeholder ("the
          // string argument must be of type string"), so we serialise + cast
          // explicitly (Drizzle's column mapper is bypassed inside raw `sql`).
          erasedAt: sql<Date>`COALESCE(${members.erasedAt}, ${opts.erasedAt.toISOString()}::timestamptz)`,
          updatedAt: opts.erasedAt,
        })
        .where(eq(members.memberId, memberId))
        .returning({ memberId: members.memberId });
      if (updated.length === 0) return err({ code: 'repo.not_found' });
      return ok(undefined);
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
    const rows = await runInTenant(ctx, async (tx) => {
      // Cursor predicates are specific to this (cursor) caller, so they stay
      // outside buildDirectoryWhere and are and()-combined with it below.
      const cursorConds: SQL[] = [];

      // Cursor: decode base64 → "<iso>|<memberId>" or "NULL|<memberId>"
      if (filter.cursor) {
        try {
          const decoded = Buffer.from(filter.cursor, 'base64').toString('utf8');
          const [iso, memberIdPart] = decoded.split('|');
          if (memberIdPart) {
            if (iso === 'NULL') {
              // NULL lastActivityAt — compare only by memberId within the
              // NULLS LAST tail segment (DESC ordering).
              cursorConds.push(
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
              cursorConds.push(
                sql`(${members.lastActivityAt} < ${iso}::timestamptz OR (${members.lastActivityAt} = ${iso}::timestamptz AND ${members.memberId} > ${memberIdPart}))`,
              );
            }
          }
        } catch {
          /* malformed cursor → ignore */
        }
      }

      const whereClause = and(buildDirectoryWhere(filter), ...cursorConds)!;

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
      const result = await runInTenant(ctx, async (tx) => {
        const whereClause = buildDirectoryWhere(filter);

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
        // memberNumber ASC NULLS LAST uses the unique index on (tenant_id, member_number).
        const orderBy =
          filter.sort === 'engagement'
            ? [
                filter.order === 'asc'
                  ? sql`${members.riskScore} DESC NULLS LAST`
                  : sql`${members.riskScore} ASC NULLS LAST`,
                asc(members.memberId),
              ]
            : filter.sort === 'memberNumber'
              ? [
                  filter.order === 'desc'
                    ? sql`${members.memberNumber} DESC NULLS LAST`
                    : sql`${members.memberNumber} ASC NULLS LAST`,
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
            and(
              // COMP-1 H4 — an erased member must never be a broadcast
              // recipient (erasure keeps `status`, stamps only `erased_at`).
              isNull(members.erasedAt),
              eq(members.broadcastsHaltedUntilAdminReview, false),
              ...(tierFilter ? [tierFilter] : []),
            ),
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
          .where(
            and(
              // COMP-1 H4 — drop erased tombstones from the admin halt queue.
              isNull(members.erasedAt),
              eq(members.broadcastsHaltedUntilAdminReview, true),
            ),
          ),
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
   * "Pending" = `consumed_at IS NULL` — an UNCONSUMED invitation,
   * whether still live OR already expired-unaccepted. Cluster 3 fix
   * (2026-07-12): an expired-but-never-accepted invite MUST surface so
   * the member-detail page can show "Invitation expired" + a re-invite
   * affordance instead of a false "Portal linked" badge. The
   * `expires_at > NOW()` predicate was dropped; the caller derives an
   * `expired` flag from `expiresAt` to pick the badge.
   *
   * Cluster 3 review (2026-07-12) — two guards close the "expired badge
   * on an ALREADY-ACTIVE contact" hole:
   *
   *   1. ACTIVE-USER ANTI-JOIN. `reissueInvitation` INSERTs a fresh
   *      invitation row WITHOUT invalidating the old one (the documented
   *      two-live-tokens posture). So an invited → expired → re-sent →
   *      REDEEMED user still owns the ORIGINAL unconsumed+expired row.
   *      Filtering per-row on `consumed_at IS NULL` would surface that
   *      stale row forever (the old `expires_at > NOW()` filter self-healed
   *      it within ≤7 days). The `NOT EXISTS` sub-select excludes any
   *      contact whose linked user has EVER consumed an invitation — a
   *      consumed invite means the user activated, so no re-invite is due.
   *      Keyed on `consumed_at`, which is chamber_app-visible (migration
   *      0017); it deliberately does NOT reach into `users.status`.
   *
   *   2. DISTINCT ON per contact, latest-expiry first. `SELECT DISTINCT ON
   *      (contacts.contact_id) … ORDER BY contacts.contact_id,
   *      invitations.expires_at DESC` returns exactly ONE row per contact —
   *      the freshest unconsumed invite. This replaces the old
   *      `ORDER BY expires_at ASC` + LIMIT 50, which could accumulate one
   *      expired row per re-issue and, once >50 piled up ASC-first, drop
   *      the newest live invite off the end. The caller's
   *      `new Map(rows.map(...))` still works — one row per contact means no
   *      last-write-wins reliance. LIMIT 50 now caps distinct contacts.
   */
  async findPendingInvitationsForMember(ctx, memberId) {
    try {
      const rows = await runInTenant(ctx, async (tx) => {
        // Second reference to `invitations` for the active-user anti-join.
        // Aliased so the correlated `user_id` refs resolve unambiguously
        // (mirrors the `directoryPlanNameSubquery` alias pattern above).
        const consumedInv = alias(invitations, 'consumed_inv');
        return tx
          .selectDistinctOn([contacts.contactId], {
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
              // Cluster 3 (2026-07-12): NO `expires_at > NOW()` filter —
              // an expired-but-unconsumed invite must surface so the UI
              // can offer a re-invite instead of a dead-end "Portal linked".
              isNull(invitations.consumedAt),
              // Cluster 3 review (2026-07-12) anti-join — exclude any
              // contact whose linked user has EVER consumed an invitation
              // (= they activated). Guards against the stale-unconsumed row
              // a redeemed user retains after a re-issue (two live tokens).
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(consumedInv)
                  .where(
                    and(
                      eq(consumedInv.userId, invitations.userId),
                      isNotNull(consumedInv.consumedAt),
                    ),
                  ),
              ),
            ),
          )
          // DISTINCT ON (contact_id) requires contact_id to lead ORDER BY;
          // expires_at DESC then keeps the LATEST-expiry unconsumed invite
          // per contact (one row per contact, freshest wins).
          .orderBy(contacts.contactId, desc(invitations.expiresAt))
          .limit(50);
      });
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

  async findPendingInvitationsForPrimaryContacts(ctx, memberIds) {
    if (memberIds.length === 0) return ok([]);
    try {
      const rows = await runInTenant(ctx, async (tx) => {
        // Second reference to `invitations` for the active-user anti-join,
        // aliased so the correlated user_id refs resolve unambiguously.
        const consumedInv = alias(invitations, 'consumed_inv');
        return tx
          .selectDistinctOn([contacts.memberId], {
            memberId: contacts.memberId,
            expiresAt: invitations.expiresAt,
          })
          .from(invitations)
          .innerJoin(contacts, eq(contacts.linkedUserId, invitations.userId))
          .where(
            and(
              inArray(contacts.memberId, [...memberIds]),
              eq(contacts.isPrimary, true),
              isNull(contacts.removedAt),
              // An expired-but-unconsumed invite MUST surface (it is the
              // re-invite signal), so there is deliberately no expires_at
              // filter here.
              isNull(invitations.consumedAt),
              // Never-redeemed anti-join — see the port doc, guard 1.
              notExists(
                tx
                  .select({ one: sql`1` })
                  .from(consumedInv)
                  .where(
                    and(
                      eq(consumedInv.userId, invitations.userId),
                      isNotNull(consumedInv.consumedAt),
                    ),
                  ),
              ),
            ),
          )
          // DISTINCT ON (member_id) requires member_id to lead ORDER BY;
          // expires_at DESC then keeps the freshest unconsumed invite.
          .orderBy(contacts.memberId, desc(invitations.expiresAt));
      });
      return ok(
        rows.map((r) => ({
          memberId: r.memberId as MemberId,
          expiresAt: r.expiresAt,
        })),
      );
    } catch (e) {
      return err(unexpected(e));
    }
  },
};
