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
import type { CycleId } from '../../domain/renewal-cycle';
import type { SupportedLocale } from '../../application/ports/renewal-gateway';
import type {
  DispatchCandidate,
  DispatchCandidateListArgs,
  DispatchCandidatePage,
  DispatchCandidateRepo,
} from '../../application/ports/dispatch-candidate-repo';

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
        // The grace period is included (members are reminded post-expiry
        // for the schedule's positive-offset steps).
        const filters: SQL[] = [
          sql`${renewalCycles.status} IN ('upcoming','reminded','awaiting_payment','grace')`,
          sql`${renewalCycles.expiresAt} <= ${args.cutoffExpiresAt}`,
          sql`${renewalCycles.expiresAt} >= NOW() - (${args.maxOffsetDays}::int * INTERVAL '1 day')`,
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
          .select({
            // cycle columns (full row for cycleRowToDomain)
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
            cycleLinkedCreditNoteId: renewalCycles.linkedCreditNoteId,
            cycleClosedAt: renewalCycles.closedAt,
            cycleClosedReason: renewalCycles.closedReason,
            cycleCreatedAt: renewalCycles.createdAt,
            cycleUpdatedAt: renewalCycles.updatedAt,
            // member columns
            memberStatus: members.status,
            memberCompanyName: members.companyName,
            memberPreferredLocale: members.preferredLocale,
            memberEmailUnverified: members.emailUnverified,
            memberRenewalRemindersOptedOut: members.renewalRemindersOptedOut,
            memberRegistrationDate: members.registrationDate,
            // primary contact (LATERAL)
            contactId: contacts.contactId,
            contactEmail: contacts.email,
            contactFirstName: contacts.firstName,
            contactLastName: contacts.lastName,
            contactPreferredLanguage: contacts.preferredLanguage,
            // schedule policy (LEFT JOIN)
            policyStepsJsonb: tenantRenewalSchedulePolicies.stepsJsonb,
            policyCreatedAt: tenantRenewalSchedulePolicies.createdAt,
            policyUpdatedAt: tenantRenewalSchedulePolicies.updatedAt,
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
          .orderBy(asc(renewalCycles.expiresAt), asc(renewalCycles.cycleId))
          .limit(args.pageSize + 1);

        const hasMore = rows.length > args.pageSize;
        const pageRows = hasMore ? rows.slice(0, args.pageSize) : rows;

        const items: DispatchCandidate[] = pageRows.map((r) => {
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
            linkedCreditNoteId: r.cycleLinkedCreditNoteId,
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
                    preferredLanguage: narrowContactLanguage(
                      r.contactPreferredLanguage,
                    ),
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
        });

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
          .select({
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
          .where(eq(renewalCycles.cycleId, cycleId))
          .limit(1);
        const r = rows[0];
        if (!r) return null;
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
          linkedCreditNoteId: r.cycleLinkedCreditNoteId,
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
                  preferredLanguage: narrowContactLanguage(
                    r.contactPreferredLanguage,
                  ),
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
      });
    },
  };
}
