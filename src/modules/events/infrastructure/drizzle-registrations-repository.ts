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
import type { EventRegistrationAggregate } from '../domain/event-registration';
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

function toAggregate(row: EventRegistrationRow): EventRegistrationAggregate {
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
    match: {
      type: row.matchType as MatchType,
      matchedMemberId: row.matchedMemberId as MemberId | null,
      matchedContactId: row.matchedContactId as ContactId | null,
    },
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
    async findByEmailLower() {
      return err({ kind: 'not_implemented', method: 'findByEmailLower', futureTask: 'Phase 10 T110' });
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
    async updateMatchAndQuota() {
      return err({ kind: 'not_implemented', method: 'updateMatchAndQuota', futureTask: 'Phase 9 T104' });
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
          .orderBy(asc(eventRegistrations.matchedMemberId), asc(eventRegistrations.registrationId));
        return ok(rows.map(toAggregate));
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
    async listPseudonymiseEligible() {
      return err({ kind: 'not_implemented', method: 'listPseudonymiseEligible', futureTask: 'Phase 10 T113' });
    },
    async pseudonymiseRow() {
      return err({ kind: 'not_implemented', method: 'pseudonymiseRow', futureTask: 'Phase 10 T113' });
    },
    async hardDelete() {
      return err({ kind: 'not_implemented', method: 'hardDelete', futureTask: 'Phase 10 T110' });
    },
  };
}
