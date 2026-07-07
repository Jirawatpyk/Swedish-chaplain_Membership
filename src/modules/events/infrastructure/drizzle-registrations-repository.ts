/**
 * T049 — Drizzle event_registrations repository (F6 Infrastructure).
 *
 * Implements `RegistrationsRepository` port. Shipped scope:
 *   - Phase 3 (T049): `insertOnConflictDoNothing` (FR-011 second
 *     idempotency layer; ON CONFLICT path returns
 *     `isNewRegistration = false` so the use-case can still surface
 *     the matching aggregate for the 200 OK response) + `findById`
 *   - Phase 4 (T059b): `findByEventId` (paginated attendee table +
 *     full-event matchCounts aggregate, with unmatchedOnly +
 *     matchTypeFilter + ilike substring filters)
 *
 * Phase 6 wave-1+3+4 added: `countConsumedByMember` (T086 quota
 * adapter), `setQuotaEffect` (T085 wiring), `markRefunded` (FR-018
 * refund flip), `listForRequota` (T087 + archive snapshots). Remaining
 * stubs (`findByEmailLower`, `updateMatchAndQuota`, `listPseudonymiseEligible`,
 * `pseudonymiseRow`, `hardDelete`) still throw `not_implemented` until
 * Phase 9 (T104) and Phase 10 (T110+T113) land them.
 */
import { and, asc, desc, eq, inArray, or, sql, ilike, like, type SQL } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';

/**
 * R6 SEC-R6-01 — `listForRequota` row cap. See call-site comment for
 * full rationale. Module-level const so the SELECT and the post-fetch
 * `>= LIST_FOR_REQUOTA_CAP` check stay in lockstep + the value is
 * inspectable in tests.
 */
export const LIST_FOR_REQUOTA_CAP = 2000;

/**
 * F6 remediation PR 2.1 / P1 (FR-032a by-email erasure) — row cap for
 * `findByEmailLower`. A single attendee email is realistically shared by
 * only a handful of registrations at SweCham scale (one person, N events),
 * but the by-email enumeration feeds a DESTRUCTIVE bulk-erase fan-out, so a
 * defensive ceiling keeps a single DSR from loading an unbounded result set
 * into memory. `.limit(FIND_BY_EMAIL_CAP + 1)` + slice distinguishes
 * "exactly at cap, nothing dropped" from "over cap, follow-up sweep needed";
 * the module const keeps the SELECT and the post-fetch check in lockstep and
 * inspectable in tests. Dormant at current scale.
 */
export const FIND_BY_EMAIL_CAP = 500;
import { eventRegistrations, events, type EventRegistrationRow } from './schema';
import type {
  RegistrationsRepository,
  InsertRegistrationInput,
  InsertRegistrationResult,
  ListRegistrationsByEventInput,
  ListRegistrationsByEventResult,
  RegistrationsRepositoryError,
  CountConsumedByMemberInput,
} from '../application/ports/registrations-repository';
import {
  asMatchResolutionView,
  MatchResolutionInvariantError,
  type EventRegistrationAggregate,
} from '../domain/event-registration';
import type {
  EventId,
  RegistrationId,
  ExternalAttendeeId,
  AttendeeEmail,
} from '../domain/branded-types';
import {
  type MatchType,
  NON_QUOTA_MATCH_TYPES,
} from '../domain/value-objects/match-type';
import { wrapRepoError } from './sanitize-db-error';
import type { PaymentStatus } from '../domain/value-objects/payment-status';
import type { TenantId, MemberId, ContactId } from '@/modules/members';

/**
 * Drizzle declares `attendeeEmailLower` as nullable (because it's a
 * STORED generated column — `$inferInsert` doesn't require it).
 * Postgres enforces the invariant at write-time (the GENERATED
 * expression cannot be NULL when `attendeeEmail` is non-NULL), but
 * the Drizzle type-system can't see that. Read sites MUST go through
 * this helper which folds the DB invariant back into a
 * guaranteed-non-null value by recomputing the lowercase form from
 * `attendeeEmail` when the generated column unexpectedly returns
 * null. Wired into Phase 10 T110 `findByEmailLower` + retention
 * sweep; the helper exists now so Application layer never depends
 * on `row.attendeeEmailLower !== null` ambient typing.
 */
export function readAttendeeEmailLower(row: EventRegistrationRow): string {
  if (row.attendeeEmailLower !== null) return row.attendeeEmailLower;
  return row.attendeeEmail.toLowerCase();
}

/**
 * R5.2.1 / Round 4 I-1 — exported for unit testing the read-time
 * invariant defense (catch + metric + log + re-throw). The function is
 * private to module callers in production code; the export carries a
 * `_` prefix to signal "infrastructure-test seam only".
 */
export function _toAggregateForTesting(row: EventRegistrationRow): EventRegistrationAggregate {
  return toAggregate(row);
}

function toAggregate(row: EventRegistrationRow): EventRegistrationAggregate {
  // R3.4.2 / IMP-1 — invariant-error collapse defense-in-depth.
  // Wrap the H3.2 `asMatchResolutionView` narrowing with a try/catch
  // that emits a structured log + bumps the metric counter BEFORE
  // re-throwing. The throw IS load-bearing (preserves the
  // throw-on-invariant contract); the catch adds a forensic
  // breadcrumb if migration 0136 CHECK is ever weakened or RLS
  // surfaces a row that violates the invariant. SRE alert wired:
  // `eventcreate_match_resolution_invariant_violation_total > 0` for
  // ≥1 min → P1 page (see docs/observability.md § F6 alerts).
  let match: ReturnType<typeof asMatchResolutionView>;
  try {
    match = asMatchResolutionView({
      type: row.matchType as MatchType,
      matchedMemberId: row.matchedMemberId as MemberId | null,
      matchedContactId: row.matchedContactId as ContactId | null,
    });
  } catch (e) {
    if (e instanceof MatchResolutionInvariantError) {
      logger.error(
        {
          event: 'f6_match_resolution_invariant_violation',
          tenantId: String(row.tenantId),
          registrationId: String(row.registrationId),
          eventId: String(row.eventId),
          matchType: row.matchType,
          matchedMemberId: row.matchedMemberId === null ? null : 'set',
          matchedContactId: row.matchedContactId === null ? null : 'set',
        },
        '[F6] event_registrations row violates match-resolution invariant at READ time — likely DB CHECK regression or RLS misconfig',
      );
      eventcreateMetrics.matchResolutionInvariantViolation(String(row.tenantId));
    } else {
      // R5.3.3 / Round 4 I-6 — log unexpected throws so a future
      // refactor that introduces a different error class (or a
      // type-system regression that throws a plain string) does not
      // silently lose the forensic breadcrumb. The P1 alert only
      // fires for MatchResolutionInvariantError; a sibling alert can
      // be wired on `f6_unexpected_throw_in_asMatchResolutionView` if
      // that becomes a recurring incident class.
      logger.error(
        {
          event: 'f6_unexpected_throw_in_asMatchResolutionView',
          tenantId: String(row.tenantId),
          registrationId: String(row.registrationId),
          eventId: String(row.eventId),
          err: e instanceof Error
            ? { name: e.name, message: e.message }
            : { name: 'non_error', message: String(e) },
        },
        '[F6] unexpected throw inside asMatchResolutionView — investigate',
      );
    }
    throw e;
  }
  return {
    tenantId: row.tenantId as TenantId,
    registrationId: row.registrationId as RegistrationId,
    eventId: row.eventId as EventId,
    externalId: row.externalId as ExternalAttendeeId,
    attendee: {
      email: row.attendeeEmail as AttendeeEmail,
      name: row.attendeeName,
      company: row.attendeeCompany,
    },
    match,
    ticket: {
      type: row.ticketType,
      priceThb: row.ticketPriceThb,
      paymentStatus: row.paymentStatus as PaymentStatus,
    },
    quotaEffect: {
      countedAgainstPartnership: row.countedAgainstPartnership,
      countedAgainstCulturalQuota: row.countedAgainstCulturalQuota,
    },
    metadata: row.metadata,
    registeredAt: new Date(row.registeredAt),
    importedAt: new Date(row.importedAt),
    piiPseudonymisedAt: row.piiPseudonymisedAt ? new Date(row.piiPseudonymisedAt) : null,
  };
}

export function makeDrizzleRegistrationsRepository(executor: TenantTx): RegistrationsRepository {
  return {
    async insertOnConflictDoNothing(
      input: InsertRegistrationInput,
    ): Promise<Result<InsertRegistrationResult, RegistrationsRepositoryError>> {
      try {
        const inserted = await executor
          .insert(eventRegistrations)
          .values({
            tenantId: input.tenantId,
            eventId: input.eventId,
            externalId: input.externalId,
            attendeeEmail: input.attendee.email,
            attendeeName: input.attendee.name,
            attendeeCompany: input.attendee.company,
            matchType: input.match.type,
            matchedMemberId: input.match.matchedMemberId,
            matchedContactId: input.match.matchedContactId,
            ticketType: input.ticket.type,
            ticketPriceThb: input.ticket.priceThb,
            paymentStatus: input.ticket.paymentStatus,
            countedAgainstPartnership: input.quotaEffect.countedAgainstPartnership,
            countedAgainstCulturalQuota: input.quotaEffect.countedAgainstCulturalQuota,
            metadata: input.metadata,
            registeredAt: input.registeredAt,
            // F6.1 (FR-009 column population) — PDPA consent persists to
            // the dedicated BOOLEAN column added by migration 0140.
            // Input is tri-state `boolean | null` per TYPE-D2 (Round 1);
            // `null` writes NULL, `true`/`false` writes the literal.
            // Three states preserved end-to-end.
            attendeePdpaConsentAcknowledged: input.pdpaConsentAcknowledged,
            // attendee_email_lower omitted — STORED generated column
            // (see readAttendeeEmailLower helper above for the full WHY).
          })
          .onConflictDoUpdate({
            // Single-statement ON CONFLICT DO UPDATE with identity
            // assignment. Closes the TOCTOU window that the previous
            // DO NOTHING + fallback SELECT pattern had (race against
            // Phase 10 hardDelete between INSERT and SELECT could
            // return zero rows). With DO UPDATE the row is ALWAYS
            // returned in a single statement: either the freshly-
            // inserted row, or the existing conflicting row with
            // externalId reassigned to itself (no-op).
            // `xmax = 0` discriminator distinguishes fresh insert
            // from conflict.
            target: [
              eventRegistrations.tenantId,
              eventRegistrations.eventId,
              eventRegistrations.externalId,
            ],
            set: {
              // Identity update — sets externalId to itself. Drizzle
              // requires at least one SET column to avoid invalid
              // SQL. The column value is unchanged (DB stores the
              // same string).
              externalId: sql`EXCLUDED.external_id`,
            },
          })
          .returning({
            tenantId: eventRegistrations.tenantId,
            registrationId: eventRegistrations.registrationId,
            eventId: eventRegistrations.eventId,
            externalId: eventRegistrations.externalId,
            attendeeEmail: eventRegistrations.attendeeEmail,
            attendeeEmailLower: eventRegistrations.attendeeEmailLower,
            attendeeName: eventRegistrations.attendeeName,
            attendeeCompany: eventRegistrations.attendeeCompany,
            matchType: eventRegistrations.matchType,
            matchedMemberId: eventRegistrations.matchedMemberId,
            matchedContactId: eventRegistrations.matchedContactId,
            ticketType: eventRegistrations.ticketType,
            ticketPriceThb: eventRegistrations.ticketPriceThb,
            paymentStatus: eventRegistrations.paymentStatus,
            countedAgainstPartnership: eventRegistrations.countedAgainstPartnership,
            countedAgainstCulturalQuota: eventRegistrations.countedAgainstCulturalQuota,
            metadata: eventRegistrations.metadata,
            registeredAt: eventRegistrations.registeredAt,
            importedAt: eventRegistrations.importedAt,
            piiPseudonymisedAt: eventRegistrations.piiPseudonymisedAt,
            isNewRegistration: sql<boolean>`(xmax = 0)`,
          });

        if (inserted.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations upsert: ON CONFLICT DO UPDATE returned no row — likely RLS misconfiguration or schema drift',
          });
        }
        const row = inserted[0]!;
        return ok({
          registration: toAggregate(row as unknown as EventRegistrationRow),
          isNewRegistration: row.isNewRegistration,
        });
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },

    async findById(
      tenantId: TenantId,
      registrationId: RegistrationId,
    ): Promise<Result<EventRegistrationAggregate | null, RegistrationsRepositoryError>> {
      try {
        const rows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          )
          .limit(1);
        if (rows.length === 0) return ok(null);
        return ok(toAggregate(rows[0]!));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },

    async listMemberRegistrationsInTx(
      tenantId: TenantId,
      memberId: MemberId,
    ): Promise<
      ReadonlyArray<{
        readonly registrationId: RegistrationId;
        readonly eventId: EventId;
      }>
    > {
      // COMP-1 US2c — member-erasure F6 fan-out enumeration. Threads the
      // caller's tenant-scoped `executor` (tx from runInTenant) so RLS +
      // the explicit tenant_id predicate scope the read to this tenant.
      // Rides `event_regs_tenant_matched_member_idx (tenant_id,
      // matched_member_id)` (migration 0131). FAIL-LOUD: no try/catch —
      // a DB error MUST propagate so the best-effort fan-out treats it as
      // a failure (re-driven by the reconciler), never as "0 registrations".
      const rows = await executor
        .select({
          registrationId: eventRegistrations.registrationId,
          eventId: eventRegistrations.eventId,
        })
        .from(eventRegistrations)
        .where(
          and(
            eq(eventRegistrations.tenantId, tenantId),
            eq(eventRegistrations.matchedMemberId, memberId),
          ),
        );
      return rows.map((r) => ({
        registrationId: r.registrationId as RegistrationId,
        eventId: r.eventId as EventId,
      }));
    },

    async findByEventId(
      input: ListRegistrationsByEventInput,
    ): Promise<
      Result<ListRegistrationsByEventResult, RegistrationsRepositoryError>
    > {
      try {
        const baseFilters = [
          eq(eventRegistrations.tenantId, input.tenantId),
          eq(eventRegistrations.eventId, input.eventId),
        ];

        // matchTypeFilter takes precedence over unmatchedOnly when both
        // are specified (matchType is more specific). When matchTypeFilter
        // is null and unmatchedOnly is true, broaden to the NON_QUOTA set.
        const matchFilter: SQL | undefined =
          input.matchTypeFilter !== null
            ? eq(eventRegistrations.matchType, input.matchTypeFilter)
            : input.unmatchedOnly
              ? inArray(
                  eventRegistrations.matchType,
                  NON_QUOTA_MATCH_TYPES as unknown as readonly string[],
                )
              : undefined;

        let searchFilter: SQL | undefined;
        if (input.emailSearch !== null && input.emailSearch !== '') {
          // attendee_email_lower is a STORED generated column backed by
          // `event_regs_tenant_email_lower_idx` (migration 0131). Use
          // `like` (not `ilike`) so the btree text_pattern_ops planner
          // can pick the index — Postgres `ILIKE` cannot use a regular
          // btree text index. Lowercase the pattern at the application
          // boundary so the comparison stays case-insensitive.
          // `attendee_name` has no lowered column → keep `ilike` there
          // (the trigram GIN on attendee_name still serves substring).
          const lowerPattern = `%${input.emailSearch.toLowerCase()}%`;
          const pattern = `%${input.emailSearch}%`;
          searchFilter = or(
            like(eventRegistrations.attendeeEmailLower, lowerPattern),
            ilike(eventRegistrations.attendeeName, pattern),
          );
        }

        const itemFilters: SQL[] = [...baseFilters];
        if (matchFilter) itemFilters.push(matchFilter);
        if (searchFilter) itemFilters.push(searchFilter);
        if (
          input.paymentStatusFilter !== null &&
          input.paymentStatusFilter !== undefined
        ) {
          itemFilters.push(
            eq(eventRegistrations.paymentStatus, input.paymentStatusFilter),
          );
        }

        // When unmatchedOnly is true, sort `unmatched` first (admin
        // reviews ambiguous matches before non-members) per AS4 / P4.
        const orderClauses = input.unmatchedOnly
          ? [
              sql`CASE WHEN ${eventRegistrations.matchType} = 'unmatched' THEN 0 ELSE 1 END`,
              desc(eventRegistrations.registeredAt),
            ]
          : [
              desc(eventRegistrations.registeredAt),
              asc(eventRegistrations.registrationId),
            ];

        // Three independent reads — issue in parallel. Cuts admin
        // detail-route p95 latency by ~2× at SweCham scale (<5k regs
        // per event). matchCounts uses baseFilters only (full-event
        // total); the other two share itemFilters (paginated subset).
        const [matchCountRows, countRowResult, rows] = await Promise.all([
          executor
            .select({
              matchType: eventRegistrations.matchType,
              count: sql<number>`COUNT(*)::int`,
            })
            .from(eventRegistrations)
            .where(and(...baseFilters))
            .groupBy(eventRegistrations.matchType),
          executor
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(eventRegistrations)
            .where(and(...itemFilters)),
          executor
            .select()
            .from(eventRegistrations)
            .where(and(...itemFilters))
            .orderBy(...orderClauses)
            .limit(input.pageSize)
            .offset(input.offset),
        ]);

        const matchCounts = {
          memberContact: 0,
          memberDomain: 0,
          memberFuzzy: 0,
          nonMember: 0,
          unmatched: 0,
        };
        for (const row of matchCountRows) {
          const n = Number(row.count);
          switch (row.matchType as MatchType) {
            case 'member_contact':
              matchCounts.memberContact += n;
              break;
            case 'member_domain':
              matchCounts.memberDomain += n;
              break;
            case 'member_fuzzy':
              matchCounts.memberFuzzy += n;
              break;
            case 'non_member':
              matchCounts.nonMember += n;
              break;
            case 'unmatched':
              matchCounts.unmatched += n;
              break;
          }
        }

        const [countRow] = countRowResult;
        const totalCount = Number(countRow?.count ?? 0);

        return ok({
          items: rows.map(toAggregate),
          totalCount,
          matchCounts,
        });
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async findByEmailLower(
      tenantId: TenantId,
      emailLower: string,
    ): Promise<
      Result<
        {
          readonly rows: ReadonlyArray<EventRegistrationAggregate>;
          readonly truncated: boolean;
        },
        RegistrationsRepositoryError
      >
    > {
      // F6 remediation PR 2.1 / P1 (FR-032a by-email erasure BACKEND) —
      // enumerate every registration whose `attendee_email_lower` EXACTLY
      // equals the (lowercased) caller email, across all of a tenant's events.
      // Threads the caller's tenant-scoped `executor` (tx from runInTenant) so
      // RLS + the explicit `tenant_id` predicate scope the read to this tenant
      // (two-layer isolation). Rides `event_regs_tenant_email_lower_idx
      // (tenant_id, attendee_email_lower)` (migration 0131) — NO new index.
      //
      // EXACT equality (not ILIKE substring): a DSR erases the person whose
      // email IS X, not everyone whose email CONTAINS X. Pseudonymised rows
      // carry a salted hash in `attendee_email_lower`, so they never collide
      // with a real address — excluded implicitly, no extra filter (P1 brief).
      try {
        const rows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.attendeeEmailLower, emailLower.toLowerCase()),
            ),
          )
          .orderBy(
            desc(eventRegistrations.registeredAt),
            asc(eventRegistrations.registrationId),
          )
          .limit(FIND_BY_EMAIL_CAP + 1);
        // Derive `truncated` from the RAW row count (BEFORE slicing to CAP) so
        // the completeness signal is accurate: `.limit(CAP+1)` returns one extra
        // row iff there are more than CAP matches (I-1 review finding).
        const truncated = rows.length > FIND_BY_EMAIL_CAP;
        const safeRows = truncated ? rows.slice(0, FIND_BY_EMAIL_CAP) : rows;
        if (truncated) {
          // NEVER log the attendee email / name / company — that PII is
          // exactly what a downstream erasure removes. `tenantId` + `cap`
          // only. A truncation means a single DSR has >500 registrations
          // sharing one email → the by-email sweep must be re-run to
          // completeness (idempotent: erased rows drop out on re-enumeration).
          logger.warn(
            {
              event: 'f6_find_by_email_cap_hit',
              tenantId,
              cap: FIND_BY_EMAIL_CAP,
            },
            `[F6] findByEmailLower truncated at ${FIND_BY_EMAIL_CAP} — data subject has more registrations than the cap; a follow-up by-email sweep is required for completeness`,
          );
        }
        return ok({ rows: safeRows.map(toAggregate), truncated });
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async countConsumedByMember(
      input: CountConsumedByMemberInput,
    ): Promise<Result<number, RegistrationsRepositoryError>> {
      try {
        if (input.scope.kind === 'partnership_per_event') {
          // Per-event partnership scope: count rows for THIS event where
          // counted_against_partnership = true. Tenant-isolation enforced
          // by RLS + explicit tenant_id predicate (belt-and-braces).
          const rows = await executor
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(eventRegistrations)
            .where(
              and(
                eq(eventRegistrations.tenantId, input.tenantId),
                eq(eventRegistrations.matchedMemberId, input.memberId),
                eq(eventRegistrations.eventId, input.scope.eventId),
                eq(eventRegistrations.countedAgainstPartnership, true),
              ),
            );
          return ok(Number(rows[0]?.count ?? 0));
        }
        // Cultural per-year scope: count rows across all this member's
        // events with counted_against_cultural_quota = true whose event's
        // start_date falls in the supplied fiscalYear (calendar year in
        // Asia/Bangkok wall time per FR-016). Joined on events to get
        // start_date; uses partial idx `events_tenant_cultural_event_idx`
        // + per-tenant matched_member idx on event_registrations.
        const culturalRows = await executor
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(eventRegistrations)
          .innerJoin(
            events,
            and(
              eq(events.tenantId, eventRegistrations.tenantId),
              eq(events.eventId, eventRegistrations.eventId),
            ),
          )
          .where(
            and(
              eq(eventRegistrations.tenantId, input.tenantId),
              eq(eventRegistrations.matchedMemberId, input.memberId),
              eq(eventRegistrations.countedAgainstCulturalQuota, true),
              sql`EXTRACT(YEAR FROM ${events.startDate} AT TIME ZONE 'Asia/Bangkok')::int = ${input.scope.fiscalYear}`,
            ),
          );
        return ok(Number(culturalRows[0]?.count ?? 0));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async updateMatchAndQuota(
      tenantId: TenantId,
      registrationId: RegistrationId,
      nextMatch,
      nextQuotaEffect,
    ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>> {
      try {
        // F6 Phase 9 / T104 admin relink path. FR-014 — pseudonymised
        // rows are immutable (defence-in-depth at the DB layer; the
        // Application use-case also pre-checks). The `pii_pseudonymised_at
        // IS NULL` clause makes the UPDATE a no-op for purged rows;
        // the probe below discriminates not-found vs pseudonymised so
        // the caller surfaces the right error kind to admins.
        //
        // Note on CHECK constraints (migrations 0128 + 0136):
        //   - match_type ∈ {member_contact, member_domain, member_fuzzy,
        //     non_member, unmatched}
        //   - non_member/unmatched MUST have null member_id + null
        //     contact_id + counted_*=false
        //   - matched_member_id is non-null only for member_* types
        // The Application caller (`relink-registration`) always writes
        // match_type='member_contact' + a real memberId + null
        // contactId; the resulting row satisfies both constraints
        // because match_type is NOT in the (non_member, unmatched)
        // forbid list and matched_member_id is non-null.
        const updated = await executor
          .update(eventRegistrations)
          .set({
            matchType: nextMatch.type,
            matchedMemberId: nextMatch.matchedMemberId,
            matchedContactId: nextMatch.matchedContactId,
            countedAgainstPartnership: nextQuotaEffect.countedAgainstPartnership,
            countedAgainstCulturalQuota: nextQuotaEffect.countedAgainstCulturalQuota,
          })
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
            ),
          )
          .returning();
        if (updated.length === 0) {
          // Discriminate row-missing vs pseudonymised (mirrors
          // `setQuotaEffect` above). Best-effort under READ COMMITTED:
          // a concurrent retention sweep or `hardDelete` could race
          // between the UPDATE (which matched 0 rows because
          // pii_pseudonymised_at became non-null) and this probe SELECT
          // (which could see the row pseudonymised, or now-deleted by
          // FR-032a `erase-attendee-pii`). The classification is
          // therefore advisory — both 409 outcomes are admin-actionable
          // ("retry / refresh"), so the rare misclassification is not a
          // correctness hazard.
          const probe = await executor
            .select({
              piiPseudonymisedAt: eventRegistrations.piiPseudonymisedAt,
            })
            .from(eventRegistrations)
            .where(
              and(
                eq(eventRegistrations.tenantId, tenantId),
                eq(eventRegistrations.registrationId, registrationId),
              ),
            )
            .limit(1);
          if (probe.length === 0) {
            // Row vanished between findById (step 1 of the relink
            // use-case) and this UPDATE — most likely a concurrent
            // `erase-attendee-pii` (FR-032a) won the race. Treat as a
            // discriminated repo error; the route maps it to a 500
            // with full pino context for SRE triage, OR (post-FR-032a
            // ship) we can promote to `registration_not_found` once
            // the erasure flow is live and the race becomes expected.
            return err({
              kind: 'invariant_violation',
              invariant:
                'event_registrations.updateMatchAndQuota: row vanished between findById and UPDATE — likely concurrent erasure (FR-032a) or schema drift; admin should retry',
            });
          }
          return err({ kind: 'pseudonymised_row_rejected', registrationId });
        }
        return ok(toAggregate(updated[0]!));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async findByEventAndEmail(
      tenantId: TenantId,
      eventId: EventId,
      emailLower: string,
    ): Promise<Result<EventRegistrationAggregate | null, RegistrationsRepositoryError>> {
      try {
        // S-11 (R1 R2 — code-reviewer): deterministic ordering when
        // duplicates exist on (tenant, event, email_lower). The unique
        // constraint is on (tenant, event, external_id) — a future bug
        // where two attendees share an email would otherwise return
        // ANY matching row non-deterministically. ORDER BY registered_at
        // then registrationId pins selection to the oldest registration.
        const rows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.eventId, eventId),
              eq(eventRegistrations.attendeeEmailLower, emailLower.toLowerCase()),
            ),
          )
          .orderBy(asc(eventRegistrations.registeredAt), asc(eventRegistrations.registrationId))
          .limit(1);
        if (rows.length === 0) return ok(null);
        return ok(toAggregate(rows[0]!));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },

    async updatePaymentStatus(
      tenantId: TenantId,
      registrationId: RegistrationId,
      nextPaymentStatus: PaymentStatus,
    ): Promise<
      Result<
        {
          readonly registration: EventRegistrationAggregate;
          readonly previousPaymentStatus: PaymentStatus;
        },
        RegistrationsRepositoryError
      >
    > {
      try {
        const prevRows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          )
          .limit(1);
        if (prevRows.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations.updatePaymentStatus: row not found — caller passed a registrationId with no matching row in this tenant',
          });
        }
        const prevRow = prevRows[0]!;
        if (prevRow.piiPseudonymisedAt !== null) {
          return err({ kind: 'pseudonymised_row_rejected', registrationId });
        }
        const previousPaymentStatus = prevRow.paymentStatus as PaymentStatus;
        // Idempotent — same status is a no-op UPDATE; still return ok
        // so callers can check the previousPaymentStatus === next case
        // without branching on the Result.
        const updated = await executor
          .update(eventRegistrations)
          .set({ paymentStatus: nextPaymentStatus })
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
            ),
          )
          .returning();
        if (updated.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations.updatePaymentStatus: row vanished between SELECT and UPDATE',
          });
        }
        return ok({
          registration: toAggregate(updated[0]!),
          previousPaymentStatus,
        });
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },

    async markRefunded(
      tenantId: TenantId,
      registrationId: RegistrationId,
    ): Promise<
      Result<
        {
          readonly registration: EventRegistrationAggregate;
          readonly previousQuotaEffect: import('../domain/event-registration').QuotaEffect;
          readonly previousPaymentStatus: PaymentStatus;
        },
        RegistrationsRepositoryError
      >
    > {
      try {
        // Capture previous state BEFORE the UPDATE so the audit emission
        // knows which scopes flipped true → false. SELECT + UPDATE in
        // the same tx + under the caller's advisory lock so a concurrent
        // ingest cannot interleave.
        const prevRows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          )
          .limit(1);
        if (prevRows.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations.markRefunded: row not found — caller passed a registrationId with no matching row in this tenant',
          });
        }
        const prevRow = prevRows[0]!;
        if (prevRow.piiPseudonymisedAt !== null) {
          return err({ kind: 'pseudonymised_row_rejected', registrationId });
        }
        const previousQuotaEffect = {
          countedAgainstPartnership: prevRow.countedAgainstPartnership,
          countedAgainstCulturalQuota: prevRow.countedAgainstCulturalQuota,
        };
        const previousPaymentStatus = prevRow.paymentStatus as PaymentStatus;

        const updated = await executor
          .update(eventRegistrations)
          .set({
            paymentStatus: 'refunded',
            countedAgainstPartnership: false,
            countedAgainstCulturalQuota: false,
          })
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
            ),
          )
          .returning();
        if (updated.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations.markRefunded: row vanished between SELECT and UPDATE — likely a concurrent erasure',
          });
        }
        return ok({
          registration: toAggregate(updated[0]!),
          previousQuotaEffect,
          previousPaymentStatus,
        });
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async listForRequota(
      tenantId: TenantId,
      eventId: EventId,
    ): Promise<Result<ReadonlyArray<EventRegistrationAggregate>, RegistrationsRepositoryError>> {
      try {
        const rows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.eventId, eventId),
              eq(eventRegistrations.paymentStatus, 'paid'),
              sql`${eventRegistrations.matchedMemberId} IS NOT NULL`,
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
            ),
          )
          .orderBy(asc(eventRegistrations.matchedMemberId), asc(eventRegistrations.registrationId))
          // R6 SEC-R6-01 (R7 ERR-FR-01 hardened) — defensive row cap.
          // Archive + toggle loops hold a single tx for the entire
          // N-iteration credit-back pass; an event with thousands of
          // paid+matched registrations could monopolise a connection
          // slot for >10s (PERF-R6-01 raises Vercel maxDuration to 60,
          // but pool pressure is a separate concern). SweCham's
          // largest realistic event historically <200 attendees;
          // 2000 is the defense-in-depth ceiling for future MTA
          // tenants. At SweCham scale this guard is dormant.
          //
          // **R7 ERR-FR-01 fix** — use `.limit(LIST_FOR_REQUOTA_CAP + 1)`
          // and slice down to `LIST_FOR_REQUOTA_CAP` for the return
          // value. This lets us distinguish "exactly at cap, no data
          // lost" (raw rows.length === cap, NO warn) from "over cap,
          // some rows silently dropped" (raw rows.length === cap+1,
          // warn fires with truncated=true). The previous `>= cap`
          // check fired false-positive warnings for any event landing
          // exactly at 2000 rows.
          .limit(LIST_FOR_REQUOTA_CAP + 1);
        const truncated = rows.length > LIST_FOR_REQUOTA_CAP;
        const safeRows = truncated ? rows.slice(0, LIST_FOR_REQUOTA_CAP) : rows;
        // R6 SEC-R6-01 follow-up closure — emit a structured
        // `logger.warn` ONLY when truncation actually happened so
        // operators discover dropped rows via Vercel runtime logs
        // rather than via the `registrationsAffected < actual N`
        // discrepancy on the macro audit row. Promoting this to a
        // dedicated audit_event_type (`event_archive_row_cap_hit`)
        // is a Phase 11 follow-up if the cap is actually hit in
        // production — current scale + log-warn is sufficient signal.
        if (truncated) {
          logger.warn(
            {
              event: 'f6_list_for_requota_cap_hit',
              tenantId,
              eventId,
              cap: LIST_FOR_REQUOTA_CAP,
              rowsReturned: safeRows.length,
              truncated: true,
              droppedAtLeast: rows.length - LIST_FOR_REQUOTA_CAP,
            },
            `[F6] listForRequota truncated — at least ${rows.length - LIST_FOR_REQUOTA_CAP} row(s) silently dropped from credit-back; follow-up sweep required`,
          );
        }
        return ok(safeRows.map(toAggregate));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async setQuotaEffect(
      tenantId: TenantId,
      registrationId: RegistrationId,
      nextQuotaEffect,
    ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>> {
      try {
        // FR-014 — pseudonymised rows are immutable except for the
        // pseudonymisation sweep itself. Defensive guard at the
        // adapter layer; matches the relink-flow precedent in T104.
        const updated = await executor
          .update(eventRegistrations)
          .set({
            countedAgainstPartnership: nextQuotaEffect.countedAgainstPartnership,
            countedAgainstCulturalQuota: nextQuotaEffect.countedAgainstCulturalQuota,
          })
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
            ),
          )
          .returning();
        if (updated.length === 0) {
          // Either the row doesn't exist (would be an invariant_violation
          // since the caller just inserted it) OR pii_pseudonymised_at
          // is non-null. Re-read to discriminate.
          const probe = await executor
            .select({
              piiPseudonymisedAt: eventRegistrations.piiPseudonymisedAt,
            })
            .from(eventRegistrations)
            .where(
              and(
                eq(eventRegistrations.tenantId, tenantId),
                eq(eventRegistrations.registrationId, registrationId),
              ),
            )
            .limit(1);
          if (probe.length === 0) {
            return err({
              kind: 'invariant_violation',
              invariant:
                'event_registrations.setQuotaEffect: row not found — caller passed a registrationId that has no row in this tenant',
            });
          }
          return err({ kind: 'pseudonymised_row_rejected', registrationId });
        }
        return ok(toAggregate(updated[0]!));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async listPseudonymiseEligible(
      tenantId: TenantId,
      olderThan: Date,
      pageSize: number,
    ): Promise<Result<ReadonlyArray<EventRegistrationAggregate>, RegistrationsRepositoryError>> {
      // Phase 10 T113 — retention sweep eligibility scan per FR-032.
      // Filters:
      //   - matchType ∈ {non_member, unmatched}
      //   - piiPseudonymisedAt IS NULL
      //   - registeredAt < olderThan (2 years ago)
      // Ordered by registeredAt ASC for FIFO sweep (oldest rows first
      // — bounded so a partial sweep at least processes the oldest
      // PII first per PDPA Section 37 / GDPR Art. 30 priority).
      try {
        const rows = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              sql`${eventRegistrations.matchType} IN ('non_member','unmatched')`,
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
              sql`${eventRegistrations.registeredAt} < ${olderThan.toISOString()}`,
            ),
          )
          .orderBy(eventRegistrations.registeredAt)
          .limit(pageSize);
        return ok(rows.map(toAggregate));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async pseudonymiseRow(
      tenantId: TenantId,
      registrationId: RegistrationId,
      pseudonymisedEmail: AttendeeEmail,
      pseudonymisedName: string,
      pseudonymisedCompany: string | null,
      pseudonymisedAt: Date,
    ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>> {
      // Phase 10 T113 — replace attendee_email + attendee_name +
      // attendee_company with deterministic salted hashes + stamp
      // piiPseudonymisedAt. Idempotent: re-running on an already-
      // pseudonymised row updates nothing material; returns the
      // existing aggregate via the WHERE-piiPseudonymisedAt-IS-NULL
      // guard (returning zero rows → SELECT existing + return).
      try {
        const updated = await executor
          .update(eventRegistrations)
          .set({
            attendeeEmail: pseudonymisedEmail,
            attendeeName: pseudonymisedName,
            attendeeCompany: pseudonymisedCompany,
            piiPseudonymisedAt: pseudonymisedAt,
          })
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
              sql`${eventRegistrations.piiPseudonymisedAt} IS NULL`,
            ),
          )
          .returning();
        if (updated.length > 0) {
          return ok(toAggregate(updated[0]!));
        }
        // Row not updated — either doesn't exist, or already pseudonymised.
        // SELECT to disambiguate.
        const probe = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          )
          .limit(1);
        if (probe.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations.pseudonymiseRow: row not found — caller passed a registrationId with no matching row in this tenant',
          });
        }
        // Already pseudonymised — idempotent no-op success.
        return ok(toAggregate(probe[0]!));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
    async hardDelete(
      tenantId: TenantId,
      registrationId: RegistrationId,
    ): Promise<Result<EventRegistrationAggregate, RegistrationsRepositoryError>> {
      // Phase 10 T110 — admin erasure hard delete. Caller (use-case)
      // already verified the row exists + path-eventId matches BEFORE
      // emitting the `pii_erasure_requested` audit + acquiring the
      // advisory lock, so by the time this DELETE runs, the row IS
      // expected to be present. An empty `returning()` therefore
      // indicates a concurrent erasure / RLS misconfiguration —
      // surface as `invariant_violation` (same shape as markRefunded's
      // post-SELECT-vanish guard).
      try {
        const deleted = await executor
          .delete(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              eq(eventRegistrations.registrationId, registrationId),
            ),
          )
          .returning();
        if (deleted.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'event_registrations.hardDelete: row vanished between findById and DELETE — likely a concurrent erasure',
          });
        }
        return ok(toAggregate(deleted[0]!));
      } catch (e) {
        return err(wrapRepoError('registrations', e));
      }
    },
  };
}
