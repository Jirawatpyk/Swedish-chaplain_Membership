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
            // Drizzle's $inferInsert requires `attendeeEmailLower` because
            // the schema marks it `.notNull()`, but Postgres materialises
            // it via STORED generated column from `attendee_email`. The
            // `as unknown as` cast bypasses the strict insert-shape check;
            // the GENERATED column populates the value at INSERT time.
          } as unknown as typeof eventRegistrations.$inferInsert)
          .onConflictDoNothing({
            target: [
              eventRegistrations.tenantId,
              eventRegistrations.eventId,
              eventRegistrations.externalId,
            ],
          })
          .returning();

        if (inserted.length > 0) {
          return ok({
            registration: toAggregate(inserted[0]!),
            wasFresh: true,
          });
        }

        // Conflict — fetch the existing row to return.
        const existing = await executor
          .select()
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, input.tenantId),
              eq(eventRegistrations.eventId, input.eventId),
              eq(eventRegistrations.externalId, input.externalId),
            ),
          )
          .limit(1);
        if (existing.length === 0) {
          return err({ kind: 'db_error', message: 'ON CONFLICT but no existing row found — race violated invariant' });
        }
        return ok({
          registration: toAggregate(existing[0]!),
          wasFresh: false,
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
    async findByEventId() {
      return err({ kind: 'db_error', message: 'findByEventId() not implemented until Phase 4 T058' });
    },
    async findByEmailLower() {
      return err({ kind: 'db_error', message: 'findByEmailLower() not implemented until Phase 10 T110' });
    },
    async countConsumedByMember() {
      return err({ kind: 'db_error', message: 'countConsumedByMember() not implemented until Phase 6 T086' });
    },
    async updateMatchAndQuota() {
      return err({ kind: 'db_error', message: 'updateMatchAndQuota() not implemented until Phase 9 T104' });
    },
    async listPseudonymiseEligible() {
      return err({ kind: 'db_error', message: 'listPseudonymiseEligible() not implemented until Phase 10 T113' });
    },
    async pseudonymiseRow() {
      return err({ kind: 'db_error', message: 'pseudonymiseRow() not implemented until Phase 10 T113' });
    },
    async hardDelete() {
      return err({ kind: 'db_error', message: 'hardDelete() not implemented until Phase 10 T110' });
    },
  };
}

// Sentinel used by `findById` when the suppression reference matters.
void sql;
