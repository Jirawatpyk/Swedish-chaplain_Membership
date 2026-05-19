/**
 * T048 — Drizzle events repository (F6 Infrastructure).
 *
 * Implements `EventsRepository` port. Shipped scope:
 *   - Phase 3 (T048): `upsert` (FR-010 last-write-wins ON CONFLICT)
 *     · `findById` · `findByExternalId`
 *   - Phase 4 (T059): `list` (offset+pageSize+totalCount paginated)
 *     · `getEmptyContext` (3-variant empty-state hints)
 *     · `getMatchCountsByEventIds` (batched GROUP BY for match-rate)
 *
 * Remaining methods (`setArchived`, `setPartnerBenefit`,
 * `setCulturalEvent`) throw `not_implemented` until Phase 6 (T087)
 * and Phase 10 (T107) land them.
 *
 * RLS reality: all SELECTs/INSERTs must run inside `runInTenant(ctx, fn)`
 * so the chamber_app role + `app.current_tenant` GUC are set. The
 * repository accepts a `TenantTx` executor — never the root `db` — to
 * prevent accidental RLS-bypass.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, isNotNull, sql } from 'drizzle-orm';
import { ok, err, type Result } from '@/lib/result';
import type { TenantTx } from '@/lib/db';
import {
  events,
  eventRegistrations,
  tenantWebhookConfigs,
  type EventRow,
} from './schema';
import type {
  EventsRepository,
  EventMatchCounts,
  EventsListEmptyContext,
  ListEventsInput,
  ListEventsResult,
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
import { NON_QUOTA_MATCH_TYPES } from '../domain/value-objects/match-type';
import { wrapRepoError } from './sanitize-db-error';
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
        // Single-statement upsert via Drizzle's onConflictDoUpdate
        // with raw `xmax = 0` discriminator. Closes the TOCTOU window
        // that the two-step DO NOTHING + fallback UPDATE pattern had
        // (race when a concurrent setArchived hit the same row) AND
        // saves the extra ~10-15ms RTT on the conflict path. Postgres
        // `xmax` is the system column that's 0 on a fresh INSERT and
        // non-zero on UPDATE — idiomatic upsert-discriminator pattern.
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
            wasFresh: sql<boolean>`(xmax = 0)`,
          });

        if (result.length === 0) {
          return err({
            kind: 'invariant_violation',
            invariant:
              'events upsert: ON CONFLICT DO UPDATE returned no row — likely RLS misconfiguration or schema drift',
          });
        }
        const row = result[0]!;
        return ok({
          event: toAggregate(row as unknown as EventRow),
          eventCreated: row.wasFresh,
        });
      } catch (e) {
        return err(wrapRepoError('events', e));
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
        return err(wrapRepoError('events', e));
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
        return err(wrapRepoError('events', e));
      }
    },

    async list(
      input: ListEventsInput,
    ): Promise<Result<ListEventsResult, EventsRepositoryError>> {
      try {
        // Build the WHERE clause. tenant_id is set by RLS but we
        // also include it explicitly so the query uses the
        // tenant_id-prefixed indexes (events_tenant_start_active_idx
        // etc. per migration 0130). Belt-and-braces — both layers
        // of Principle I tenant isolation apply.
        const conditions = [eq(events.tenantId, input.tenantId)];
        if (!input.includeArchived) {
          conditions.push(isNull(events.archivedAt));
        }
        if (input.partnerBenefitOnly) {
          conditions.push(eq(events.isPartnerBenefit, true));
        }
        if (input.culturalEventOnly) {
          conditions.push(eq(events.isCulturalEvent, true));
        }
        if (input.categoryFilter !== null) {
          conditions.push(eq(events.category, input.categoryFilter));
        }
        if (input.searchQuery !== undefined) {
          const trimmed = input.searchQuery.trim();
          if (trimmed.length > 0) {
            // Case-insensitive substring match on event_name. SweCham
            // scale (~200 events/year) makes a sequential scan
            // acceptable — the primary
            // `events_tenant_start_active_idx` still drives row
            // selection (tenant_id + archived_at partial); ILIKE
            // filters the remaining candidate set in-memory. Upgrade
            // to a pg_trgm GIN on `events.name` (mirroring F3 members)
            // if p95 ever exceeds 500ms — F6.2 backlog.
            conditions.push(ilike(events.name, `%${trimmed}%`));
          }
        }
        const whereClause = and(...conditions);

        // Total-count query — same WHERE, no LIMIT/OFFSET — kept
        // separate from the items SELECT to keep the row-projection
        // index-friendly. At SweCham scale (<200 events/year) this
        // is sub-10ms; F4 invoice-list precedent for the same pattern.
        // R005 (staff-review fix 2026-05-13): issue the two SELECTs
        // in parallel. RLS GUC + chamber_app role are already SET in
        // the surrounding `runInTenant` tx — concurrent queries on
        // the same pooled connection are safe because Drizzle serial-
        // ises them at the connection layer, and the parallel send
        // saves one round-trip of network latency.
        const [countRowResult, rows] = await Promise.all([
          executor
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(events)
            .where(whereClause),
          executor
            .select()
            .from(events)
            .where(whereClause)
            .orderBy(desc(events.startDate), asc(events.eventId))
            .limit(input.pageSize)
            .offset(input.offset),
        ]);
        const [countRow] = countRowResult;
        const totalCount = Number(countRow?.count ?? 0);

        return ok({
          items: rows.map(toAggregate),
          totalCount,
        });
      } catch (e) {
        return err(wrapRepoError('events', e));
      }
    },

    async getMatchCountsByEventIds(
      tenantId: TenantId,
      eventIds: ReadonlyArray<EventId>,
    ): Promise<
      Result<ReadonlyMap<EventId, EventMatchCounts>, EventsRepositoryError>
    > {
      if (eventIds.length === 0) return ok(new Map());
      try {
        // Single GROUP BY — emits one row per event_id × match_type
        // bucket. Application folds buckets into total/matched
        // counts (matched = NOT non_member AND NOT unmatched).
        const rows = await executor
          .select({
            eventId: eventRegistrations.eventId,
            matchType: eventRegistrations.matchType,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(eventRegistrations)
          .where(
            and(
              eq(eventRegistrations.tenantId, tenantId),
              inArray(eventRegistrations.eventId, eventIds as EventId[]),
            ),
          )
          .groupBy(eventRegistrations.eventId, eventRegistrations.matchType);

        const nonQuotaSet = new Set<string>(
          NON_QUOTA_MATCH_TYPES as readonly string[],
        );
        const map = new Map<EventId, { total: number; matched: number }>();
        for (const row of rows) {
          const evId = row.eventId as EventId;
          const entry = map.get(evId) ?? { total: 0, matched: 0 };
          const n = Number(row.count);
          entry.total += n;
          if (!nonQuotaSet.has(row.matchType)) entry.matched += n;
          map.set(evId, entry);
        }
        const out = new Map<EventId, EventMatchCounts>();
        for (const [k, v] of map) {
          out.set(k, {
            totalRegistrations: v.total,
            matchedRegistrations: v.matched,
          });
        }
        return ok(out);
      } catch (e) {
        return err(wrapRepoError('events', e));
      }
    },

    async getEmptyContext(
      tenantId: TenantId,
    ): Promise<Result<EventsListEmptyContext, EventsRepositoryError>> {
      try {
        // Two compact lookups in parallel: webhook config existence
        // + archived count. Each is index-backed and runs in <5ms
        // at SweCham scale.
        const [configRows, archivedCountRows] = await Promise.all([
          executor
            .select({
              enabled: tenantWebhookConfigs.enabled,
              lastReceivedAt: tenantWebhookConfigs.lastReceivedAt,
            })
            .from(tenantWebhookConfigs)
            .where(eq(tenantWebhookConfigs.tenantId, tenantId))
            .limit(1),
          executor
            .select({ count: sql<number>`COUNT(*)::int` })
            .from(events)
            .where(
              and(
                eq(events.tenantId, tenantId),
                isNotNull(events.archivedAt),
              ),
            ),
        ]);
        const config = configRows[0];
        const integrationConfigured = Boolean(config?.enabled);
        const everReceivedDelivery = config?.lastReceivedAt != null;
        const totalArchived = Number(archivedCountRows[0]?.count ?? 0);
        return ok({
          integrationConfigured,
          everReceivedDelivery,
          totalArchived,
        });
      } catch (e) {
        return err(wrapRepoError('events', e));
      }
    },

    setArchived: (tenantId, eventId, archivedAt) =>
      updateEventRow(executor, tenantId, eventId, 'setArchived', {
        archivedAt,
        lastUpdatedAt: archivedAt,
      }),
    setPartnerBenefit: (tenantId, eventId, next) =>
      updateEventRow(executor, tenantId, eventId, 'setPartnerBenefit', {
        isPartnerBenefit: next,
        lastUpdatedAt: new Date(),
      }),
    setCulturalEvent: (tenantId, eventId, next) =>
      updateEventRow(executor, tenantId, eventId, 'setCulturalEvent', {
        isCulturalEvent: next,
        lastUpdatedAt: new Date(),
      }),
  };
}

/**
 * Phase 6 wave-5 REFACTOR H2 — file-local helper extracted from the
 * 3 near-identical `setArchived` / `setPartnerBenefit` /
 * `setCulturalEvent` adapter methods. Each was ~30 lines of mechanical
 * UPDATE-then-return-or-invariant-violation; this collapses them to
 * 4-line delegates while preserving the per-method `invariant`
 * message label (the only meaningful per-call variance).
 *
 * Keeps `wrapRepoError` + `invariant_violation` + the tenant-scoped
 * WHERE clause as the single source of truth for the F6 event-flag
 * UPDATE shape.
 */
async function updateEventRow(
  executor: TenantTx,
  tenantId: TenantId,
  eventId: EventId,
  invariantLabel: 'setArchived' | 'setPartnerBenefit' | 'setCulturalEvent',
  setValues: Partial<typeof events.$inferInsert>,
): Promise<Result<EventAggregate, EventsRepositoryError>> {
  try {
    const updated = await executor
      .update(events)
      .set(setValues)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.eventId, eventId),
        ),
      )
      .returning();
    if (updated.length === 0) {
      return err({
        kind: 'invariant_violation',
        invariant: `events.${invariantLabel}: row not found — caller passed an eventId with no matching row in this tenant`,
      });
    }
    return ok(toAggregate(updated[0]!));
  } catch (e) {
    return err(wrapRepoError('events', e));
  }
}
