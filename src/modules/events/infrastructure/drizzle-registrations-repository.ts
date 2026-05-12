/**
 * T049 — Drizzle event_registrations repository (F6 Infrastructure).
 *
 * Implements `RegistrationsRepository` port. Phase 3 GREEN scope covers
 * `insertOnConflictDoNothing` (FR-011 second idempotency layer) +
 * `findById`. Other methods land in later phases.
 *
 * The ON CONFLICT path returns `wasFresh = false` so the use-case can
 * still surface the matching aggregate (read the existing row) for the
 * 200 OK response.
 */
import { and, eq, sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import { eventRegistrations, type EventRegistrationRow } from './schema';
import type {
  RegistrationsRepository,
  InsertRegistrationInput,
  InsertRegistrationResult,
  RegistrationsRepositoryError,
} from '../application/ports/registrations-repository';
import type { EventRegistrationAggregate } from '../domain/event-registration';
import type {
  EventId,
  RegistrationId,
  ExternalAttendeeId,
  AttendeeEmail,
} from '../domain/branded-types';
import type { MatchType } from '../domain/value-objects/match-type';
import type { PaymentStatus } from '../domain/value-objects/payment-status';
import type { TenantId, MemberId, ContactId } from '@/modules/members';

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
            // Issue C-FULL-5 (review 2026-05-12): `attendee_email_lower`
            // is a STORED generated column — Drizzle schema now declares
            // it as nullable so `$inferInsert` no longer requires it.
            // The `as unknown as` cast that previously bypassed the
            // strict typing has been removed; the insert below is fully
            // type-safe.
          })
          .onConflictDoUpdate({
            // Issue I-FULL-2 (review 2026-05-12) — switch from
            // DO NOTHING + fallback SELECT to DO UPDATE with an
            // identity assignment. Closes the previous TOCTOU window
            // (race against Phase 10 T110 hardDelete between INSERT and
            // SELECT could return zero rows → false "race invariant"
            // error). With DO UPDATE, the row is ALWAYS returned in a
            // single statement: either the freshly-inserted row, or
            // the existing conflicting row with externalId reassigned
            // to itself (no-op). `xmax = 0` discriminator distinguishes
            // fresh insert from conflict.
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
            wasFresh: sql<boolean>`(xmax = 0)`,
          });

        if (inserted.length === 0) {
          return err({ kind: 'db_error', message: 'registration upsert: ON CONFLICT DO UPDATE returned no row (invariant violation)' });
        }
        const row = inserted[0]!;
        return ok({
          registration: toAggregate(row as unknown as EventRegistrationRow),
          wasFresh: row.wasFresh,
        });
      } catch (e) {
        return err({
          kind: 'db_error',
          message: e instanceof Error ? e.message : String(e),
        });
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
        return err({
          kind: 'db_error',
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },

    // --- Stubs for later phases ---------------------------------------------
    // Issue I6 (review 2026-05-12) — distinct `not_implemented` kind
    // so dashboards separate phase-not-yet-wired from genuine DB errors.
    async findByEventId() {
      return err({ kind: 'not_implemented', method: 'findByEventId', futureTask: 'Phase 4 T058' });
    },
    async findByEmailLower() {
      return err({ kind: 'not_implemented', method: 'findByEmailLower', futureTask: 'Phase 10 T110' });
    },
    async countConsumedByMember() {
      return err({ kind: 'not_implemented', method: 'countConsumedByMember', futureTask: 'Phase 6 T086' });
    },
    async updateMatchAndQuota() {
      return err({ kind: 'not_implemented', method: 'updateMatchAndQuota', futureTask: 'Phase 9 T104' });
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

// Sentinel used by `findById` when the suppression reference matters.
void sql;
