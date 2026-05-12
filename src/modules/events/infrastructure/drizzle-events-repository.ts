/**
 * T048 — Drizzle events repository (F6 Infrastructure).
 *
 * Implements `EventsRepository` port. Phase 3 GREEN scope covers:
 *   - `upsert` — webhook ingest path (FR-010 last-write-wins). Uses
 *     INSERT ... ON CONFLICT (tenant_id, source, external_id) DO UPDATE.
 *   - `findById` — admin event detail (used by Phase 4 page)
 *   - `findByExternalId` — pre-upsert probe (rarely used; upsert
 *     does the dedup internally)
 *
 * Remaining methods (`list`, `getEmptyContext`, `setArchived`,
 * `setPartnerBenefit`, `setCulturalEvent`) throw `not_implemented`
 * until Phase 4 / Phase 6 / Phase 10 land them. Phase 3 only needs
 * `upsert` + `findById` for the ingest path.
 *
 * RLS reality: all SELECTs/INSERTs must run inside `runInTenant(ctx, fn)`
 * so the chamber_app role + `app.current_tenant` GUC are set. The
 * repository accepts a `TenantTx` executor — never the root `db` — to
 * prevent accidental RLS-bypass.
 */
import { and, eq, sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import { events, type EventRow } from './schema';
import type {
  EventsRepository,
  UpsertEventInput,
  UpsertEventResult,
  EventsRepositoryError,
} from '../application/ports/events-repository';
import type { EventAggregate } from '../domain/event';
import type {
  EventId,
  ExternalEventId,
} from '../domain/branded-types';
import type { Source } from '../domain/value-objects/source';
import type { TenantId } from '@/modules/members';

function toAggregate(row: EventRow): EventAggregate {
  return {
    tenantId: row.tenantId as TenantId,
    eventId: row.eventId as EventId,
    source: row.source as Source,
    externalId: row.externalId as ExternalEventId,
    name: row.name,
    description: row.description,
    startDate: new Date(row.startDate),
    endDate: row.endDate ? new Date(row.endDate) : null,
    location: row.location,
    category: row.category,
    eventcreateUrl: row.eventcreateUrl,
    isPartnerBenefit: row.isPartnerBenefit,
    isCulturalEvent: row.isCulturalEvent,
    archivedAt: row.archivedAt ? new Date(row.archivedAt) : null,
    metadata: row.metadata,
    importedAt: new Date(row.importedAt),
    lastUpdatedAt: new Date(row.lastUpdatedAt),
  };
}

export function makeDrizzleEventsRepository(executor: TenantTx): EventsRepository {
  return {
    async upsert(
      input: UpsertEventInput,
    ): Promise<Result<UpsertEventResult, EventsRepositoryError>> {
      try {
        // Issue C-FULL-4 (review 2026-05-12) — single-statement upsert
        // via Drizzle's onConflictDoUpdate with raw `xmax = 0`
        // discriminator. Closes the previous two-step TOCTOU window
        // (race between INSERT DO NOTHING + fallback UPDATE when a
        // concurrent Phase 4 setArchived hit the row) AND eliminates
        // the extra ~10-15ms RTT on the conflict path. Postgres `xmax`
        // is the system column that's 0 on a fresh INSERT and non-zero
        // on UPDATE — idiomatic upsert-discriminator pattern.
        const result = await executor
          .insert(events)
          .values({
            tenantId: input.tenantId,
            source: input.source,
            externalId: input.externalId,
            name: input.name,
            description: input.description,
            startDate: input.startDate,
            endDate: input.endDate,
            location: input.location,
            category: input.category,
            eventcreateUrl: input.eventcreateUrl,
            metadata: input.metadata,
          })
          .onConflictDoUpdate({
            target: [events.tenantId, events.source, events.externalId],
            set: {
              name: input.name,
              description: input.description,
              startDate: input.startDate,
              endDate: input.endDate,
              location: input.location,
              category: input.category,
              eventcreateUrl: input.eventcreateUrl,
              metadata: input.metadata,
              lastUpdatedAt: new Date(),
            },
          })
          .returning({
            tenantId: events.tenantId,
            eventId: events.eventId,
            source: events.source,
            externalId: events.externalId,
            name: events.name,
            description: events.description,
            startDate: events.startDate,
            endDate: events.endDate,
            location: events.location,
            category: events.category,
            eventcreateUrl: events.eventcreateUrl,
            isPartnerBenefit: events.isPartnerBenefit,
            isCulturalEvent: events.isCulturalEvent,
            archivedAt: events.archivedAt,
            metadata: events.metadata,
            importedAt: events.importedAt,
            lastUpdatedAt: events.lastUpdatedAt,
            // xmax = 0 ⇔ row was freshly INSERTed (no prior version);
            // xmax != 0 ⇔ row was UPDATEd by this command (had an
            // older mvcc tuple). Cast to boolean for clean API surface.
            wasFresh: sql<boolean>`(xmax = 0)`,
          });

        if (result.length === 0) {
          return err({ kind: 'db_error', message: 'upsert: ON CONFLICT DO UPDATE returned no row (invariant violation)' });
        }
        const row = result[0]!;
        return ok({
          event: toAggregate(row as unknown as EventRow),
          eventCreated: row.wasFresh,
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
      eventId: EventId,
    ): Promise<Result<EventAggregate | null, EventsRepositoryError>> {
      try {
        const rows = await executor
          .select()
          .from(events)
          .where(and(eq(events.tenantId, tenantId), eq(events.eventId, eventId)))
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

    async findByExternalId(
      tenantId: TenantId,
      source: Source,
      externalId: ExternalEventId,
    ): Promise<Result<EventAggregate | null, EventsRepositoryError>> {
      try {
        const rows = await executor
          .select()
          .from(events)
          .where(
            and(
              eq(events.tenantId, tenantId),
              eq(events.source, source),
              eq(events.externalId, externalId),
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

    // --- Phase 4 / Phase 6 / Phase 10 stubs ---------------------------------
    // These methods exist on the port interface but are not yet wired.
    // Per Issue I6 (review 2026-05-12), stubs return `kind:'not_implemented'`
    // — semantically distinct from `db_error` so dashboards/alerts can
    // separate phase-not-yet-wired calls from real Postgres failures.
    async list() {
      return err({ kind: 'not_implemented', method: 'list', futureTask: 'Phase 4 T057' });
    },
    async getEmptyContext() {
      return err({ kind: 'not_implemented', method: 'getEmptyContext', futureTask: 'Phase 4 T059' });
    },
    async setArchived() {
      return err({ kind: 'not_implemented', method: 'setArchived', futureTask: 'Phase 10 T107' });
    },
    async setPartnerBenefit() {
      return err({ kind: 'not_implemented', method: 'setPartnerBenefit', futureTask: 'Phase 6 T087' });
    },
    async setCulturalEvent() {
      return err({ kind: 'not_implemented', method: 'setCulturalEvent', futureTask: 'Phase 6 T087' });
    },
  };
}
