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
import { and, eq } from 'drizzle-orm';
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
        // Two-step upsert: INSERT...ON CONFLICT DO NOTHING first. If a
        // row was returned → fresh insert (eventCreated=true). Otherwise
        // → conflict → run UPDATE separately + read the updated row.
        // This avoids needing Postgres `xmax = 0` raw SQL inside a
        // Drizzle returning() clause (which doesn't easily accept SQL
        // alongside a full-table reference).
        const inserted = await executor
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
          .onConflictDoNothing({
            target: [events.tenantId, events.source, events.externalId],
          })
          .returning();

        if (inserted.length > 0) {
          return ok({
            event: toAggregate(inserted[0]!),
            eventCreated: true,
          });
        }

        // Conflict — perform the UPDATE (FR-010 last-write-wins) and
        // read back.
        const updated = await executor
          .update(events)
          .set({
            name: input.name,
            description: input.description,
            startDate: input.startDate,
            endDate: input.endDate,
            location: input.location,
            category: input.category,
            eventcreateUrl: input.eventcreateUrl,
            metadata: input.metadata,
            lastUpdatedAt: new Date(),
          })
          .where(
            and(
              eq(events.tenantId, input.tenantId),
              eq(events.source, input.source),
              eq(events.externalId, input.externalId),
            ),
          )
          .returning();

        if (updated.length === 0) {
          return err({ kind: 'db_error', message: 'upsert: conflict but UPDATE returned no row' });
        }
        return ok({
          event: toAggregate(updated[0]!),
          eventCreated: false,
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
    // Phase 3 ingest path doesn't call them; they return a sentinel error
    // so a future caller surfaces the missing impl loudly rather than
    // returning a silently-wrong empty result.
    async list() {
      return err({ kind: 'db_error', message: 'list() not implemented until Phase 4 T057' });
    },
    async getEmptyContext() {
      return err({ kind: 'db_error', message: 'getEmptyContext() not implemented until Phase 4 T059' });
    },
    async setArchived() {
      return err({ kind: 'db_error', message: 'setArchived() not implemented until Phase 10 T107' });
    },
    async setPartnerBenefit() {
      return err({ kind: 'db_error', message: 'setPartnerBenefit() not implemented until Phase 6 T087' });
    },
    async setCulturalEvent() {
      return err({ kind: 'db_error', message: 'setCulturalEvent() not implemented until Phase 6 T087' });
    },
  };
}
