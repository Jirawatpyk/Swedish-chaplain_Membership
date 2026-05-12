/**
 * T031a — `EventsRepository` Application port (F6).
 *
 * CRUD-ish access to the `events` table from Application use-cases. The
 * Infrastructure adapter (`drizzle-events-repository.ts`, Phase 3 T048)
 * implements via Drizzle.
 *
 * Read methods:
 *   - `findByExternalId`  — lookup pre-upsert (FR-010 webhook upsert)
 *   - `findById`          — admin events list / detail (Phase 4)
 *   - `listByTenant`      — admin events list (Phase 4)
 *   - `getEmptyContext`   — 3-variant empty-state per US2 AS5 / CHK028
 *
 * Write methods:
 *   - `upsert`            — webhook ingest path (FR-010 last-write-wins)
 *   - `archive`           — admin archive action (FR-019a, Phase 10)
 *   - `setPartnerBenefit` / `setCulturalEvent` — admin toggles (FR-019,
 *                            Phase 6 T087)
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { Result } from '@/lib/result';
import type { TenantId } from '@/modules/members';
import type {
  EventId,
  ExternalEventId,
} from '../../domain/branded-types';
import type { EventAggregate } from '../../domain/event';
import type { Source } from '../../domain/value-objects/source';

export interface UpsertEventInput {
  readonly tenantId: TenantId;
  readonly source: Source;
  readonly externalId: ExternalEventId;
  readonly name: string;
  readonly description: string | null;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly location: string | null;
  readonly category: string | null;
  readonly eventcreateUrl: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface UpsertEventResult {
  readonly event: EventAggregate;
  /** TRUE if a new row was created; FALSE if existing row was updated. */
  readonly eventCreated: boolean;
}

export interface ListEventsInput {
  readonly tenantId: TenantId;
  readonly includeArchived: boolean;
  readonly partnerBenefitOnly: boolean;
  readonly culturalEventOnly: boolean;
  readonly categoryFilter: string | null;
  readonly pageSize: number;
  readonly pageToken: string | null;
}

export interface ListEventsResult {
  readonly items: ReadonlyArray<EventAggregate>;
  readonly nextPageToken: string | null;
}

/**
 * 3-variant empty-state context per US2 AS5 / CHK028 round-5 fix.
 * - `integrationConfigured` — tenant_webhook_configs row exists
 * - `everReceivedDelivery`  — last_received_at IS NOT NULL on the
 *                              tenant_webhook_configs row
 * - `totalArchived`         — count of events.archived_at IS NOT NULL
 *                              (so "no events" vs "all archived" can be
 *                              distinguished in the empty-state UI)
 */
export interface EventsListEmptyContext {
  readonly integrationConfigured: boolean;
  readonly everReceivedDelivery: boolean;
  readonly totalArchived: number;
}

export type EventsRepositoryError =
  | { readonly kind: 'db_error'; readonly message: string }
  | {
      /**
       * Issue I6 (review 2026-05-12) — distinct from `db_error` so
       * dashboards / alert rules can separate genuine Postgres
       * failures (page someone immediately) from "phase X method
       * not yet wired" stubs (informational only — caught at code
       * review or compile time when the calling phase lands).
       */
      readonly kind: 'not_implemented';
      readonly method: string;
      readonly futureTask: string;
    };

export interface EventsRepository {
  upsert(
    input: UpsertEventInput,
  ): Promise<Result<UpsertEventResult, EventsRepositoryError>>;

  findById(
    tenantId: TenantId,
    eventId: EventId,
  ): Promise<Result<EventAggregate | null, EventsRepositoryError>>;

  findByExternalId(
    tenantId: TenantId,
    source: Source,
    externalId: ExternalEventId,
  ): Promise<Result<EventAggregate | null, EventsRepositoryError>>;

  list(
    input: ListEventsInput,
  ): Promise<Result<ListEventsResult, EventsRepositoryError>>;

  getEmptyContext(
    tenantId: TenantId,
  ): Promise<Result<EventsListEmptyContext, EventsRepositoryError>>;

  setArchived(
    tenantId: TenantId,
    eventId: EventId,
    archivedAt: Date,
  ): Promise<Result<EventAggregate, EventsRepositoryError>>;

  setPartnerBenefit(
    tenantId: TenantId,
    eventId: EventId,
    next: boolean,
  ): Promise<Result<EventAggregate, EventsRepositoryError>>;

  setCulturalEvent(
    tenantId: TenantId,
    eventId: EventId,
    next: boolean,
  ): Promise<Result<EventAggregate, EventsRepositoryError>>;
}
