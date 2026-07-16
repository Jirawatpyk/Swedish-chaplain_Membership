/**
 * F8 Phase 4 Wave I2c — Drizzle adapter for `DispatchCandidateRepo`.
 *
 * Implements the composite-query port `DispatchCandidateRepo` against:
 *   - `renewal_cycles` (own bounded context schema)
 *   - `members` (deep-import from F3 — precedent: cycle-repo)
 *   - `contacts` (deep-import from F3 — primary contact lookup)
 *   - `tenant_renewal_schedule_policies` (own schema)
 *
 * Tenant isolation: Postgres RLS+FORCE on every joined table — every
 * method wraps its query in `runInTenant(ctx, …)` which sets `SET LOCAL
 * ROLE chamber_app` + `SET LOCAL app.current_tenant`. NO explicit
 * `WHERE tenant_id = ?` — the policies add it automatically.
 *
 * Cursor pagination: reuses `encodeCursor` / `decodeCursor` from
 * `drizzle-renewal-cycle-repo.ts` so pipeline + dispatcher cursors
 * share the same HMAC-signed format (defence-in-depth against forged
 * cursors per Wave H1 W-08 / Round 5 staff review).
 */
import { and, eq, sql, asc, or, type SQL } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import type { TenantContext } from '@/modules/tenants';
import { renewalCycles } from '../schema-renewal-cycles';
import { tenantRenewalSchedulePolicies } from '../schema-tenant-renewal-config';
import { members } from '@/modules/members/infrastructure/db/schema-members';
import { contacts } from '@/modules/members/infrastructure/db/schema-contacts';
import { rowToDomain as cycleRowToDomain, encodeCursor, decodeCursor } from './drizzle-renewal-cycle-repo';
import {
  parseSchedulePolicySteps,
  type TenantRenewalSchedulePolicy,
} from '../../domain/tenant-renewal-schedule-policy';
import type { ScheduleStepJson } from '../schema-tenant-renewal-config';
import type { TierBucket } from '../../domain/value-objects/tier-bucket';
import { OPEN_CYCLE_STATUSES_SQL_LIST } from '../../domain/value-objects/cycle-status';
import type { CycleId } from '../../domain/renewal-cycle';
import type { SupportedLocale } from '../../application/ports/renewal-gateway';
import type {
  DispatchCandidate,
  DispatchCandidateListArgs,
  DispatchCandidatePage,
  DispatchCandidateRepo,
  DueTrackCandidatePage,
} from '../../application/ports/dispatch-candidate-repo';
import { MAX_INVOICE_ISSUANCE_LEAD_DAYS } from '../../domain/due-track';

// ---------------------------------------------------------------------------
// Locale narrowing helper — F3's `preferred_locale` is `text` (CHECK
// constrains values to en/th/sv); we narrow defensively.
// ---------------------------------------------------------------------------

function narrowLocale(raw: string | null): SupportedLocale | null {
  if (raw === 'en' || raw === 'th' || raw === 'sv') return raw;
  return null;
}

function narrowMemberStatus(
  raw: string,
): 'active' | 'inactive' | 'archived' {
  if (raw === 'active' || raw === 'inactive' || raw === 'archived') return raw;
  // F3 schema enum is exhaustive; this defensive narrow is a belt-and-
  // suspenders guard against a future schema change.
  throw new Error(`narrowMemberStatus: unexpected value '${raw}' from members.status`);
}

function narrowContactLanguage(raw: string): SupportedLocale {
  if (raw === 'en' || raw === 'th' || raw === 'sv') return raw;
  // contacts.preferred_language defaults to 'en' (CHAR(2)) per schema.
  // A non-{en,th,sv} value is a F3 schema regression — fail loud.
  throw new Error(
    `narrowContactLanguage: unexpected value '${raw}' from contacts.preferred_language`,
  );
}

/**
 * Parse a JSONB `steps_jsonb` array into a typed `TenantRenewalSchedulePolicy`.
 * Returns null when the row was missing (LEFT JOIN produced no match)
 * OR when the steps_jsonb fails Domain validation (DB schema regression).
 */
function parsePolicyOrNull(
  tenantId: string,
  tierBucket: TierBucket,
  rawSteps: readonly ScheduleStepJson[] | null,
  createdAt: Date | null,
  updatedAt: Date | null,
): TenantRenewalSchedulePolicy | null {
  if (!rawSteps || !createdAt || !updatedAt) return null;
  const parsed = parseSchedulePolicySteps(rawSteps);
  if (!parsed.ok) return null;
  return {
    tenantId,
    tierBucket,
    steps: parsed.value,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Shared projection + row mapper (S1 dedup — Wave J12)
//
// `list` and `findOne` query the same composite shape (cycle ⋈ member ⟕
// primary-contact ⟕ schedule-policy). Centralising the 35-column SELECT
// list and the row-to-domain mapper here keeps both methods in sync —
// adding/removing a column happens in exactly one place.
// ---------------------------------------------------------------------------

const dispatchCandidateProjection = {
  cycleTenantId: renewalCycles.tenantId,
  cycleId: renewalCycles.cycleId,
  cycleMemberId: renewalCycles.memberId,
  cyclePeriodFrom: renewalCycles.periodFrom,
  cyclePeriodTo: renewalCycles.periodTo,
  cycleExpiresAt: renewalCycles.expiresAt,
  cycleLengthMonths: renewalCycles.cycleLengthMonths,
  cycleTierAtCycleStart: renewalCycles.tierAtCycleStart,
  cyclePlanIdAtCycleStart: renewalCycles.planIdAtCycleStart,
  cycleFrozenPlanPriceThb: renewalCycles.frozenPlanPriceThb,
  cycleFrozenPlanTermMonths: renewalCycles.frozenPlanTermMonths,
  cycleFrozenPlanCurrency: renewalCycles.frozenPlanCurrency,
  cycleStatus: renewalCycles.status,
  cycleEnteredPendingAt: renewalCycles.enteredPendingAt,
  cycleLinkedInvoiceId: renewalCycles.linkedInvoiceId,
  cycleAnchoredAt: renewalCycles.anchoredAt,
  cycleAnchorInvoiceId: renewalCycles.anchorInvoiceId,
  cycleLinkedCreditNoteId: renewalCycles.linkedCreditNoteId,
  cycleClosedAt: renewalCycles.closedAt,
  cycleClosedReason: renewalCycles.closedReason,
  cycleCreatedAt: renewalCycles.createdAt,
  cycleUpdatedAt: renewalCycles.updatedAt,
  memberStatus: members.status,
  memberCompanyName: members.companyName,
  memberPreferredLocale: members.preferredLocale,
  memberEmailUnverified: members.emailUnverified,
  memberRenewalRemindersOptedOut: members.renewalRemindersOptedOut,
  memberRegistrationDate: members.registrationDate,
  contactId: contacts.contactId,
  contactEmail: contacts.email,
  contactFirstName: contacts.firstName,
  contactLastName: contacts.lastName,
  contactPreferredLanguage: contacts.preferredLanguage,
  policyStepsJsonb: tenantRenewalSchedulePolicies.stepsJsonb,
  policyCreatedAt: tenantRenewalSchedulePolicies.createdAt,
  policyUpdatedAt: tenantRenewalSchedulePolicies.updatedAt,
} as const;

// Drizzle widens LEFT-JOINed columns (contacts.*, tenantRenewalSchedulePolicies.*)
// to nullable in the query result even when source columns are NOT NULL.
// We mirror that widening here so the shared mapper accepts both
// `list` and `findOne` rows.
type DispatchCandidateRow = {
  cycleTenantId: string;
  cycleId: string;
  cycleMemberId: string;
  cyclePeriodFrom: Date;
  cyclePeriodTo: Date;
  cycleExpiresAt: Date;
  cycleLengthMonths: number;
  cycleTierAtCycleStart: string;
  cyclePlanIdAtCycleStart: string;
  cycleFrozenPlanPriceThb: string;
  cycleFrozenPlanTermMonths: number;
  cycleFrozenPlanCurrency: string;
  cycleStatus: string;
  cycleEnteredPendingAt: Date | null;
  cycleLinkedInvoiceId: string | null;
  cycleAnchoredAt: Date | null;
  cycleAnchorInvoiceId: string | null;
  cycleLinkedCreditNoteId: string | null;
  cycleClosedAt: Date | null;
  cycleClosedReason: string | null;
  cycleCreatedAt: Date;
  cycleUpdatedAt: Date;
  memberStatus: string;
  memberCompanyName: string;
  memberPreferredLocale: string | null;
  memberEmailUnverified: boolean;
  memberRenewalRemindersOptedOut: boolean;
  memberRegistrationDate: string;
  contactId: string | null;
  contactEmail: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactPreferredLanguage: string | null;
  policyStepsJsonb: readonly ScheduleStepJson[] | null;
  policyCreatedAt: Date | null;
  policyUpdatedAt: Date | null;
};

function rowToDispatchCandidate(r: DispatchCandidateRow): DispatchCandidate {
  const cycle = cycleRowToDomain({
    tenantId: r.cycleTenantId,
    cycleId: r.cycleId,
    memberId: r.cycleMemberId,
    periodFrom: r.cyclePeriodFrom,
    periodTo: r.cyclePeriodTo,
    expiresAt: r.cycleExpiresAt,
    cycleLengthMonths: r.cycleLengthMonths,
    tierAtCycleStart: r.cycleTierAtCycleStart,
    planIdAtCycleStart: r.cyclePlanIdAtCycleStart,
    frozenPlanPriceThb: r.cycleFrozenPlanPriceThb,
    frozenPlanTermMonths: r.cycleFrozenPlanTermMonths,
    frozenPlanCurrency: r.cycleFrozenPlanCurrency,
    status: r.cycleStatus,
    enteredPendingAt: r.cycleEnteredPendingAt,
    linkedInvoiceId: r.cycleLinkedInvoiceId,
    anchoredAt: r.cycleAnchoredAt,
    anchorInvoiceId: r.cycleAnchorInvoiceId,
    linkedCreditNoteId: r.cycleLinkedCreditNoteId,
    // F8-RP follow-up (migration 0243) — the async reject-with-refund marker
    // is ONLY ever set on a `pending_admin_reactivation` cycle. The dispatch-
    // candidate query lists cycles in OPEN states (upcoming/reminded/
    // awaiting_payment) only, so a candidate cycle is definitionally unmarked.
    // The projection does not SELECT the marker columns; pass null (faithful
    // for every dispatcher-eligible cycle).
    rejectRefundInitiatedAt: null,
    rejectRefundId: null,
    rejectActorUserId: null,
    closedAt: r.cycleClosedAt,
    closedReason: r.cycleClosedReason,
    createdAt: r.cycleCreatedAt,
    updatedAt: r.cycleUpdatedAt,
  });
  return {
    cycle,
    member: {
      memberId: r.cycleMemberId,
      status: narrowMemberStatus(r.memberStatus),
      companyName: r.memberCompanyName,
      preferredLocale: narrowLocale(r.memberPreferredLocale),
      emailUnverified: r.memberEmailUnverified,
      renewalRemindersOptedOut: r.memberRenewalRemindersOptedOut,
      registrationDate: String(r.memberRegistrationDate),
    },
    primaryContact:
      r.contactId &&
      r.contactEmail &&
      r.contactFirstName &&
      r.contactLastName &&
      r.contactPreferredLanguage
        ? {
            contactId: r.contactId,
            email: r.contactEmail,
            firstName: r.contactFirstName,
            lastName: r.contactLastName,
            preferredLanguage: narrowContactLanguage(r.contactPreferredLanguage),
          }
        : null,
    schedulePolicy: parsePolicyOrNull(
      r.cycleTenantId,
      r.cycleTierAtCycleStart as TierBucket,
      r.policyStepsJsonb as readonly ScheduleStepJson[] | null,
      r.policyCreatedAt,
      r.policyUpdatedAt,
    ),
  };
}

// ---------------------------------------------------------------------------
// Per-tenant factory
// ---------------------------------------------------------------------------

export function makeDrizzleDispatchCandidateRepo(
  tenant: TenantContext,
): DispatchCandidateRepo {
  return {
    async list(
      _tenantId: string,
      args: DispatchCandidateListArgs,
    ): Promise<DispatchCandidatePage> {
      return runInTenant(tenant, async (tx) => {
        const cursor = decodeCursor(args.cursor);
        // Cycles in active states only — terminal cycles are filtered.
        // The grace period is included NOT by any `'grace'` status (no DB
        // row can ever hold it — `CYCLE_STATUSES` + the migration 0087
        // `renewal_cycles_status_check` CHECK both reject it) but by the
        // DATE window below: a post-expiry cycle whose `expires_at` is no
        // older than `NOW() - maxOffsetDays days` is still returned so the
        // schedule's positive-offset (post-expiry) reminder steps fire.
        const filters: SQL[] = [
          sql`${renewalCycles.status} IN (${sql.raw(OPEN_CYCLE_STATUSES_SQL_LIST)})`,
          sql`${renewalCycles.expiresAt} <= ${args.cutoffExpiresAt}`,
          sql`${renewalCycles.expiresAt} >= NOW() - (${args.maxOffsetDays}::int * INTERVAL '1 day')`,
          // COMP-1 H4 — never dispatch a renewal reminder to a GDPR-erased
          // member (erasure keeps `status` + the cycle, stamps `erased_at`).
          sql`${members.erasedAt} IS NULL`,
        ];
        if (cursor) {
          filters.push(
            or(
              sql`${renewalCycles.expiresAt} > ${cursor.expiresAt}`,
              and(
                eq(renewalCycles.expiresAt, new Date(cursor.expiresAt)),
                sql`${renewalCycles.cycleId} > ${cursor.cycleId}`,
              ),
            )!,
          );
        }
        // Composite query — JOIN members (required) + LEFT JOIN
        // primary contact (optional) + LEFT JOIN schedule_policy
        // (optional). The LATERAL primary-contact subquery picks at
        // most one row per member via `is_primary=true AND removed_at
        // IS NULL` (enforced unique by the partial index
        // `contacts_one_primary_per_member`).
        const rows = await tx
          .select(dispatchCandidateProjection)
          .from(renewalCycles)
          .innerJoin(
            members,
            and(
              eq(members.tenantId, renewalCycles.tenantId),
              eq(members.memberId, renewalCycles.memberId),
            ),
          )
          .leftJoin(
            contacts,
            and(
              eq(contacts.tenantId, renewalCycles.tenantId),
              eq(contacts.memberId, renewalCycles.memberId),
              eq(contacts.isPrimary, true),
              sql`${contacts.removedAt} IS NULL`,
            ),
          )
          .leftJoin(
            tenantRenewalSchedulePolicies,
            and(
              eq(
                tenantRenewalSchedulePolicies.tenantId,
                renewalCycles.tenantId,
              ),
              eq(
                tenantRenewalSchedulePolicies.tierBucket,
                renewalCycles.tierAtCycleStart,
              ),
            ),
          )
          .where(and(...filters))
          .orderBy(asc(renewalCycles.expiresAt), asc(renewalCycles.cycleId))
          .limit(args.pageSize + 1);

        const hasMore = rows.length > args.pageSize;
        const pageRows = hasMore ? rows.slice(0, args.pageSize) : rows;

        const items: DispatchCandidate[] = pageRows.map(rowToDispatchCandidate);

        const nextCursor =
          hasMore && pageRows.length > 0
            ? encodeCursor({
                expiresAt:
                  pageRows[pageRows.length - 1]!.cycleExpiresAt.toISOString(),
                cycleId: pageRows[pageRows.length - 1]!.cycleId,
              })
            : null;
        return { items, nextCursor };
      });
    },

    async findOne(
      _tenantId: string,
      cycleId: CycleId,
    ): Promise<DispatchCandidate | null> {
      return runInTenant(tenant, async (tx) => {
        const rows = await tx
          .select(dispatchCandidateProjection)
          .from(renewalCycles)
          .innerJoin(
            members,
            and(
              eq(members.tenantId, renewalCycles.tenantId),
              eq(members.memberId, renewalCycles.memberId),
            ),
          )
          .leftJoin(
            contacts,
            and(
              eq(contacts.tenantId, renewalCycles.tenantId),
              eq(contacts.memberId, renewalCycles.memberId),
              eq(contacts.isPrimary, true),
              sql`${contacts.removedAt} IS NULL`,
            ),
          )
          .leftJoin(
            tenantRenewalSchedulePolicies,
            and(
              eq(
                tenantRenewalSchedulePolicies.tenantId,
                renewalCycles.tenantId,
              ),
              eq(
                tenantRenewalSchedulePolicies.tierBucket,
                renewalCycles.tierAtCycleStart,
              ),
            ),
          )
          .where(eq(renewalCycles.cycleId, cycleId))
          .limit(1);
        const r = rows[0];
        return r ? rowToDispatchCandidate(r) : null;
      });
    },

    async listDueTrackCandidates(
      _tenantId: string,
      args: { readonly pageSize: number; readonly cursor: string | null },
    ): Promise<DueTrackCandidatePage> {
      return runInTenant(tenant, async (tx) => {
        // 066 §3.2(1) — the member's oldest-due unpaid MEMBERSHIP bill,
        // FLOORED at (period_from − MAX_INVOICE_ISSUANCE_LEAD_DAYS) so the
        // warning anchor can never diverge from the §5.2 termination
        // clock's anchor (same constant, same Bangkok calendar-date
        // semantics as `bangkokLocalDate` in the lapse cron). Batched as a
        // correlated scalar subquery — one round-trip for the whole page,
        // never a per-candidate bridge call (the FIX-6 lesson). RLS also
        // guards `invoices` inside the runInTenant session.
        const oldestBillDueDate = sql<string | null>`(
          SELECT MIN(inv.due_date)
            FROM invoices inv
           WHERE inv.tenant_id = ${renewalCycles.tenantId}
             AND inv.member_id = ${renewalCycles.memberId}
             AND inv.invoice_subject = 'membership'
             AND inv.status = 'issued'
             AND inv.due_date >= (
               (${renewalCycles.periodFrom} AT TIME ZONE 'Asia/Bangkok')::date
                 - ${MAX_INVOICE_ISSUANCE_LEAD_DAYS}::int
             )
        )`;
        // NO expires_at pre-filter — a §5.3 born-awaiting cycle's
        // expires_at is ~12 months out and must not be hidden (review C1;
        // mirrors listCyclesEligibleForLapse's no-pre-filter precedent).
        const filters: SQL[] = [
          sql`${renewalCycles.status} = 'awaiting_payment'`,
          // COMP-1 H4 — never dispatch to a GDPR-erased member.
          sql`${members.erasedAt} IS NULL`,
          // Only cycles WITH an anchorable bill ride this arm; the
          // never-invoiced cohort keeps the expires_at t+N ladder.
          sql`${oldestBillDueDate} IS NOT NULL`,
        ];
        if (args.cursor) {
          filters.push(sql`${renewalCycles.cycleId} > ${args.cursor}`);
        }
        const rows = await tx
          .select({
            ...dispatchCandidateProjection,
            billDueDate: oldestBillDueDate.as('bill_due_date'),
          })
          .from(renewalCycles)
          .innerJoin(
            members,
            and(
              eq(members.tenantId, renewalCycles.tenantId),
              eq(members.memberId, renewalCycles.memberId),
            ),
          )
          .leftJoin(
            contacts,
            and(
              eq(contacts.tenantId, renewalCycles.tenantId),
              eq(contacts.memberId, renewalCycles.memberId),
              eq(contacts.isPrimary, true),
              sql`${contacts.removedAt} IS NULL`,
            ),
          )
          .leftJoin(
            tenantRenewalSchedulePolicies,
            and(
              eq(
                tenantRenewalSchedulePolicies.tenantId,
                renewalCycles.tenantId,
              ),
              eq(
                tenantRenewalSchedulePolicies.tierBucket,
                renewalCycles.tierAtCycleStart,
              ),
            ),
          )
          .where(and(...filters))
          .orderBy(asc(renewalCycles.cycleId))
          .limit(args.pageSize + 1);

        const hasMore = rows.length > args.pageSize;
        const pageRows = hasMore ? rows.slice(0, args.pageSize) : rows;
        const items = pageRows.map((r) => ({
          ...rowToDispatchCandidate(r),
          // The IS NOT NULL filter guarantees a value. T3-review M1: the
          // 'YYYY-MM-DD' wire string relies on drizzle's postgres-js
          // transparent date parser (OID 1082 pass-through); a driver that
          // parses dates to JS Date would corrupt String().slice(0,10) —
          // the defensive branch keeps it exact either way (and the
          // live-Neon test asserts exact equality as the tripwire).
          billDueDate:
            (r.billDueDate as unknown) instanceof Date
              ? (r.billDueDate as unknown as Date).toISOString().slice(0, 10)
              : String(r.billDueDate).slice(0, 10),
        }));
        const nextCursor =
          hasMore && pageRows.length > 0
            ? pageRows[pageRows.length - 1]!.cycleId
            : null;
        return { items, nextCursor };
      });
    },
  };
}
