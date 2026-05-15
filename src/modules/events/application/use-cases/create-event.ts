/**
 * `createEvent` use-case (F6.1 · T026 full impl).
 *
 * Admin-manual event creation surface for the /admin/events/import
 * page's inline-create modal. Closes the "no way to seed events" gap
 * left when EventCreate's native API moved behind Enterprise tier
 * (see `project_eventcreate_api_gated` memory + `docs/event-integration-analysis.md`):
 * Zapier webhook ingest no longer fires → admins MUST be able to seed
 * events manually before CSV upload can target them.
 *
 * Pipeline:
 *   1. Validate input (caller pre-validated via zod at route boundary).
 *   2. `eventsRepo.upsert` with source='admin_manual' — reuses the same
 *      idempotent upsert path that webhook ingest uses (FR-010 last-
 *      write-wins). Repeating the same (tenantId, externalId) returns
 *      `eventCreated: false` so admin retries are safe.
 *   3. Emit `event_created` audit (only on actual fresh insert; idempotent
 *      re-runs do NOT re-emit).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 * Tx + tenant boundary owned by Infrastructure via the injected
 * `runInTenantTx` factory.
 */
import { logger } from '@/lib/logger';
import type { TenantId } from '@/modules/members';
import type { UserId, AuditEventId } from '@/modules/auth';
import {
  asExternalEventId,
  type EventId,
} from '../../domain/branded-types';
import type {
  EventsRepository,
  EventsRepositoryError,
} from '../ports/events-repository';
import type {
  F6AuditEntry,
  F6AuditEventType,
  F6AuditPort,
  AuditEmitError,
} from '../ports/audit-port';
import type { Result } from '@/lib/result';
import { ok, err } from '@/lib/result';

// ---------------------------------------------------------------------------
// Input + Output + Outcome
// ---------------------------------------------------------------------------

export interface CreateEventInput {
  readonly tenantId: TenantId;
  readonly actorUserId: UserId;
  /**
   * Admin-supplied external identifier — typed slug like `agm-2026` or
   * `gt-workshop-2026q1`. MUST be unique within tenant when combined
   * with source='admin_manual'. Re-using the same externalId is an
   * idempotent retry (returns the existing event).
   */
  readonly externalId: string;
  readonly name: string;
  /** ISO 8601 datetime with timezone offset. */
  readonly startDate: Date;
  readonly category: string | null;
}

/**
 * Public-facing event payload returned by `createEvent` outcomes
 * (`kind: 'created' | 'already_exists'`). Intentionally omits a
 * `created` boolean — the discriminator on the outcome encodes that
 * fact, so carrying both invites drift between the two signals.
 */
export interface CreateEventOutput {
  readonly eventId: EventId;
  readonly externalId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly category: string | null;
}

export type CreateEventOutcome =
  | { readonly kind: 'created'; readonly event: CreateEventOutput }
  | { readonly kind: 'already_exists'; readonly event: CreateEventOutput }
  | {
      readonly kind: 'invalid_input';
      readonly field: 'externalId' | 'name' | 'startDate' | 'category';
      readonly reason: string;
    }
  | { readonly kind: 'db_error'; readonly message: string }
  | { readonly kind: 'unexpected_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface CreateEventTxScopedPorts {
  readonly eventsRepo: EventsRepository;
  readonly audit: F6AuditPort;
}

export interface CreateEventDeps {
  readonly runInTenantTx: <T>(
    tenantId: string,
    fn: (ports: CreateEventTxScopedPorts) => Promise<T>,
  ) => Promise<T>;
  /** Standalone-tx audit for emit failures observable independently. */
  readonly emitStandalone: <T extends F6AuditEventType>(
    entry: F6AuditEntry<T>,
  ) => Promise<Result<AuditEventId, AuditEmitError>>;
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

const EXTERNAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/i;
const NAME_MAX = 500;
const CATEGORY_MAX = 100;

export async function createEvent(
  input: CreateEventInput,
  deps: CreateEventDeps,
): Promise<CreateEventOutcome> {
  // Defensive validation — route handler does the primary zod parse;
  // this is the inner Application gate so direct test invocation can
  // still surface invalid input.
  const trimmedExternalId = input.externalId.trim();
  if (!EXTERNAL_ID_PATTERN.test(trimmedExternalId)) {
    return {
      kind: 'invalid_input',
      field: 'externalId',
      reason:
        'externalId must be 1-100 chars, alphanumeric + hyphen only (e.g. "agm-2026")',
    };
  }
  const trimmedName = input.name.trim();
  if (trimmedName.length === 0) {
    return { kind: 'invalid_input', field: 'name', reason: 'name is required' };
  }
  if (trimmedName.length > NAME_MAX) {
    return {
      kind: 'invalid_input',
      field: 'name',
      reason: `name must be ≤${NAME_MAX} chars`,
    };
  }
  if (!(input.startDate instanceof Date) || isNaN(input.startDate.getTime())) {
    return {
      kind: 'invalid_input',
      field: 'startDate',
      reason: 'startDate must be a valid Date',
    };
  }
  const trimmedCategory =
    input.category === null ? null : input.category.trim();
  if (trimmedCategory !== null && trimmedCategory.length > CATEGORY_MAX) {
    return {
      kind: 'invalid_input',
      field: 'category',
      reason: `category must be ≤${CATEGORY_MAX} chars`,
    };
  }

  try {
    const result = await deps.runInTenantTx(input.tenantId, async (ports) => {
      // Reuse the F6 idempotent upsert path. `source='admin_manual'`
      // distinguishes admin-seeded rows from EventCreate-fed ones.
      const upsert = await ports.eventsRepo.upsert({
        tenantId: input.tenantId,
        source: 'admin_manual',
        externalId: asExternalEventId(trimmedExternalId),
        name: trimmedName,
        description: null,
        startDate: input.startDate,
        endDate: null,
        location: null,
        category: trimmedCategory,
        eventcreateUrl: null,
        metadata: {},
      });
      if (!upsert.ok) {
        return err(upsert.error);
      }
      const event = upsert.value.event;
      // Audit only on actual fresh insert — idempotent re-runs SHOULD
      // NOT pollute the audit trail. Admin sees `already_exists` in
      // the UI; that surface alone is sufficient.
      if (upsert.value.eventCreated) {
        const auditResult = await ports.audit.emit({
          eventType: 'event_created',
          tenantId: input.tenantId,
          actorType: 'admin',
          actorUserId: input.actorUserId,
          occurredAt: new Date(),
          summary: `Admin created event "${trimmedName}" (externalId=${trimmedExternalId})`,
          payload: {
            severity: 'info',
            actorUserId: input.actorUserId,
            eventId: event.eventId,
            externalId: trimmedExternalId,
            source: 'admin_manual',
            name: trimmedName,
            startDate: input.startDate,
            category: trimmedCategory,
          },
        });
        if (!auditResult.ok) {
          logger.error(
            {
              event: 'f6_event_created_audit_emit_failed',
              tenantId: input.tenantId,
              eventId: event.eventId,
              err: auditResult.error.kind,
            },
            '[F6.1] event_created audit emit failed — event committed but no audit row; SRE should investigate',
          );
          // Do NOT throw — event is already committed; audit-emit
          // failure is observability concern, not transactional.
        }
      }
      return ok({
        // TYPE-D8: `eventCreated` rides on the use-case-internal Result
        // envelope and is stripped at the discriminator-conversion step
        // below (line 247) so the public `CreateEventOutcome` carries
        // no redundant field — only the discriminator
        // (`kind: 'created' | 'already_exists'`).
        event: {
          eventId: event.eventId,
          externalId: trimmedExternalId,
          name: trimmedName,
          startDate: event.startDate,
          category: event.category,
        },
        eventCreated: upsert.value.eventCreated,
      });
    });

    if (!result.ok) {
      const e = result.error as EventsRepositoryError;
      const message =
        e.kind === 'db_error'
          ? e.message
          : e.kind === 'invariant_violation'
            ? `events.upsert invariant violated: ${e.invariant}`
            : `events.upsert rejected: ${e.kind}`;
      return { kind: 'db_error', message };
    }
    const { event: output, eventCreated } = result.value;
    return eventCreated
      ? { kind: 'created', event: output }
      : { kind: 'already_exists', event: output };
  } catch (e) {
    logger.error(
      {
        event: 'f6_create_event_threw',
        tenantId: input.tenantId,
        err: e instanceof Error ? e.message : String(e),
      },
      '[F6.1] createEvent use-case threw',
    );
    return {
      kind: 'unexpected_error',
      message: e instanceof Error ? e.message : 'createEvent threw',
    };
  }
}
