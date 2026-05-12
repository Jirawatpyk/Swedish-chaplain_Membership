/**
 * T020 — `EventAggregate` (F6 Domain).
 *
 * Represents one event imported from EventCreate (or future source). The
 * aggregate is identified per tenant by `(source, externalId)` — see the
 * UNIQUE INDEX in migration 0130 — but addressed within the application
 * by `eventId` (UUID assigned at first ingest).
 *
 * Lifecycle: `archived_at` set by admin archive action (FR-019a) → new
 * webhook deliveries upsert event metadata as normal but the
 * `apply-quota-effect` use-case short-circuits to neutral.
 *
 * `metadata` jsonb carries unknown payload fields verbatim per FR-011a
 * forward-compat. Application boundary (zod schema in eventcreate-payload.ts)
 * strips canonical keys before this gets populated so a future EventCreate
 * field addition cannot collide with the typed column set.
 *
 * Pure TypeScript — Constitution Principle III. Cross-module branded
 * types come from public barrels.
 */
import type { TenantId } from '@/modules/members';
import type {
  EventId,
  ExternalEventId,
} from './branded-types';
import type { Source } from './value-objects/source';

export interface EventAggregate {
  readonly tenantId: TenantId;
  readonly eventId: EventId;
  readonly source: Source;
  readonly externalId: ExternalEventId;

  readonly name: string;
  readonly description: string | null;
  readonly startDate: Date;
  readonly endDate: Date | null;
  readonly location: string | null;
  readonly category: string | null;
  readonly eventcreateUrl: string | null;

  readonly isPartnerBenefit: boolean;
  readonly isCulturalEvent: boolean;

  readonly archivedAt: Date | null;

  readonly metadata: Readonly<Record<string, unknown>>;

  readonly importedAt: Date;
  readonly lastUpdatedAt: Date;
}

/**
 * Pure-function predicate: an archived event short-circuits quota
 * accounting (FR-019a). Used by `apply-quota-effect.ts` (Phase 6 T085).
 */
export function isArchived(event: Pick<EventAggregate, 'archivedAt'>): boolean {
  return event.archivedAt !== null;
}
