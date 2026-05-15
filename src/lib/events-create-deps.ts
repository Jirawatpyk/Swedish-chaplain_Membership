/**
 * F6.1 (Feature 013 · T026 full impl) — `createEvent` composition adapter.
 *
 * Wires the `createEvent` Application use-case to its Drizzle-backed
 * dependencies + a fresh `runInTenant` tx per invocation. Mirrors the
 * pattern from `events-csv-import-deps.ts` + `events-admin-deps.ts`:
 *   - Use-case sees Application ports only (Constitution Principle III).
 *   - Composition layer brands `actorUserId` + `tenantId` at the route
 *     boundary so the use-case never receives unbranded strings.
 *
 * Re-uses `makeDrizzleEventsRepository` + `makePinoAuditPort` — the
 * SAME adapters that the webhook ingest pipeline uses. Idempotency,
 * RLS, audit retention, and observability are all inherited.
 */
import { asTenantContext } from '@/modules/tenants';
import { runInTenant } from '@/lib/db';
import {
  createEvent,
  type CreateEventOutcome,
  type CreateEventTxScopedPorts,
  type CreateEventDeps,
  asTenantId,
  asUserId,
  type UserId,
} from '@/modules/events';
import { rateLimiter as authRateLimiter } from '@/modules/auth/infrastructure/rate-limit/upstash-rate-limiter';
import { logger } from '@/lib/logger';
import { eventcreateMetrics } from '@/lib/metrics';
import { makeDrizzleEventsRepository } from '@/modules/events/infrastructure/drizzle-events-repository';
import { makePinoAuditPort } from '@/modules/events/infrastructure/pino-audit-port';
import { makeStandaloneAuditDeps } from '@/modules/events';

const CREATE_EVENT_MAX_PER_HOUR = 30;
const CREATE_EVENT_WINDOW_SECONDS = 3600;

export interface CreateEventRateLimitResult {
  readonly success: boolean;
  readonly resetAtUnixMs: number;
}

/**
 * Per-(tenant, actor) rate-limit gate for admin event creation.
 * Sliding-window 30/hr — generous because admin seed operations are
 * front-loaded (initial tenant onboarding may create 5-10 events back-
 * to-back). Inherits fail-open + warn-log convention from F6 webhook
 * rate-limit (M-2 fix 2026-05-15).
 */
export async function createEventRateLimitCheck(
  tenantSlug: string,
  actorUserId: string,
): Promise<CreateEventRateLimitResult> {
  const result = await authRateLimiter.check(
    `f6-create-event:${tenantSlug}:${actorUserId}`,
    CREATE_EVENT_MAX_PER_HOUR,
    CREATE_EVENT_WINDOW_SECONDS,
  );
  if (result.fellBack) {
    logger.warn(
      {
        event: 'f6_create_event_rate_limit_fell_open',
        tenantSlug,
        actorUserId,
      },
      '[F6.1] createEvent rate limit Upstash unreachable — fell open; post-incident: this actor may have exceeded 30/hr cap during outage',
    );
    // R2-I3 (Round 2 — silent-failure-hunter): pair the warn log with a
    // dedicated metric so SRE has an alertable signal (log-only is not
    // enough for a fail-open path that allows arbitrary requests).
    eventcreateMetrics.createEventRateLimitFallback(tenantSlug);
  }
  return { success: result.success, resetAtUnixMs: result.reset };
}

export interface RunCreateEventInput {
  readonly tenantSlug: string;
  readonly actorUserId: UserId;
  readonly externalId: string;
  readonly name: string;
  readonly startDate: Date;
  readonly category: string | null;
}

export type RunCreateEventOutcome = CreateEventOutcome;

function makeCreateEventDeps(): CreateEventDeps {
  return {
    runInTenantTx: async <T>(
      tenantId: string,
      fn: (ports: CreateEventTxScopedPorts) => Promise<T>,
    ): Promise<T> => {
      const ctx = asTenantContext(tenantId);
      return runInTenant(ctx, async (tx) => {
        const ports: CreateEventTxScopedPorts = {
          eventsRepo: makeDrizzleEventsRepository(tx),
          audit: makePinoAuditPort(tx),
        };
        return fn(ports);
      });
    },
    emitStandalone: async (entry) => {
      const port = makeStandaloneAuditDeps();
      return port.emitStandalone(entry);
    },
  };
}

export async function runCreateEvent(
  input: RunCreateEventInput,
): Promise<RunCreateEventOutcome> {
  const deps = makeCreateEventDeps();
  const startedAtMs = Date.now();
  try {
    return await createEvent(
      {
        tenantId: asTenantId(input.tenantSlug),
        actorUserId: input.actorUserId,
        externalId: input.externalId,
        name: input.name,
        startDate: input.startDate,
        category: input.category,
      },
      deps,
    );
  } finally {
    // I1 (Round 1 — code-reviewer): use dedicated createEvent histogram
    // so ~100ms admin-manual samples don't pollute the CSV-import SLO
    // (SC-006 1k rows < 60s).
    eventcreateMetrics.createEventDurationSeconds(
      input.tenantSlug,
      (Date.now() - startedAtMs) / 1000,
    );
  }
}

// Re-export the helper from @/modules/events so callers can brand
// actorUserId without reaching deep into the module barrel.
export { asUserId };
