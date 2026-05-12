/**
 * F6 Infrastructure composition root.
 *
 * Wires the Drizzle adapter factories + the pino audit emitter into the
 * port-shaped dependencies that Application use-cases consume. Mirrors
 * F5's `src/modules/payments/infrastructure/di.ts` precedent.
 *
 * Application layer MUST NOT import from here (Constitution Principle
 * III). Composition flows: barrel → infrastructure/di → adapter
 * implementations → port interfaces (in application/ports/).
 *
 * Route handlers + tests import the `make*Deps` factories from the
 * `@/modules/events` barrel (which re-exports from this file).
 *
 * Two factories are exposed:
 *   - `makeIngestWebhookAttendeeDeps()` — full ingest pipeline with
 *     tx-bound Drizzle adapters + dual-write fallback emitters.
 *   - `makeStandaloneAuditDeps()` — minimal surface for callers (route
 *     signature-reject path, ops scripts) that only need
 *     `emitStandalone`. Avoids waste-instantiating the full Drizzle
 *     adapter stack on the hot rejection path AND prevents future
 *     contributors from mistakenly invoking `runInTenantTx` /
 *     `emitRolledBackStandalone` from a context where they shouldn't.
 */
import { asTenantContext } from '@/modules/tenants';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { AuditEventId } from '@/modules/auth';
import type {
  IngestWebhookAttendeeDeps,
  TxScopedPorts,
} from '../application/use-cases/ingest-webhook-attendee';
import type {
  F6AuditEntry,
  F6AuditEventType,
  AuditEmitError,
} from '../application/ports/audit-port';
import type { Result } from '@/lib/result';
import { makeDrizzleEventsRepository } from './drizzle-events-repository';
import { makeDrizzleRegistrationsRepository } from './drizzle-registrations-repository';
import { makeDrizzleIdempotencyStore } from './drizzle-idempotency-store';
import { makeDrizzleAttendeeMatcher } from './drizzle-attendee-matcher';
import { makePinoAuditPort } from './pino-audit-port';

/**
 * Minimal deps for callers that only need standalone-tx audit
 * emission (e.g., route signature-reject path before the ingest
 * use-case runs).
 */
export interface StandaloneAuditDeps {
  readonly emitStandalone: <T extends F6AuditEventType>(
    entry: F6AuditEntry<T>,
  ) => Promise<Result<AuditEventId, AuditEmitError>>;
}

export function makeStandaloneAuditDeps(): StandaloneAuditDeps {
  return {
    emitStandalone: async (entry) => {
      const port = makeLoudDummyExecutorPort('emitStandalone');
      return port.emitStandalone(entry);
    },
  };
}

/**
 * Full deps for the F6 webhook ingest path. Wires:
 *   - `runInTenantTx` → `@/lib/db.runInTenant` with all Drizzle adapter
 *     instances bound to the inner tx + audit emitter bound to the
 *     same tx so `audit.emit` commits atomically.
 *   - `emitRolledBackStandalone` → a fresh `makePinoAuditPort(...)`
 *     instance whose `emitRolledBack` method uses root `db.transaction`
 *     internally for the FR-037 dual-write fallback.
 *   - `emitStandalone` → same dummy-executor pattern for arbitrary
 *     out-of-tx event emission.
 *
 * Tests override individual fields to inject failures.
 */
export function makeIngestWebhookAttendeeDeps(): IngestWebhookAttendeeDeps {
  return {
    runInTenantTx: async <T>(
      tenantId: string,
      fn: (ports: TxScopedPorts) => Promise<T>,
    ): Promise<T> => {
      const ctx = asTenantContext(tenantId);
      return runInTenant(ctx, async (tx) => {
        const ports: TxScopedPorts = {
          eventsRepo: makeDrizzleEventsRepository(tx),
          registrationsRepo: makeDrizzleRegistrationsRepository(tx),
          idempotencyStore: makeDrizzleIdempotencyStore(tx),
          attendeeMatcher: makeDrizzleAttendeeMatcher(tx),
          audit: makePinoAuditPort(tx),
        };
        return fn(ports);
      });
    },

    emitRolledBackStandalone: async (entry) => {
      const port = makeLoudDummyExecutorPort('emitRolledBackStandalone');
      return port.emitRolledBack(entry);
    },

    emitStandalone: async (entry) => {
      const port = makeLoudDummyExecutorPort('emitStandalone');
      return port.emitStandalone(entry);
    },
  };
}

/**
 * Build a pino-audit-port wired with a Proxy `executor` that LOUDLY
 * fails on ANY property access. Used by the standalone composition-root
 * paths (`emitRolledBackStandalone` + `emitStandalone`) where the tx
 * argument is intentionally unused because the port's standalone
 * methods use root `db.transaction` internally.
 *
 * The Proxy is strictly tighter than a single `{ execute }` stub: if a
 * future patch to `pino-audit-port` adds a new method call on
 * `executor` (e.g., `executor.select(...)`) for some new feature, the
 * Proxy will log.fatal + throw on that access too — there's no silent
 * `undefined is not a function` path. All cast-bypass scenarios fail
 * loudly with a forensic log line.
 */
function makeLoudDummyExecutorPort(caller: string) {
  const loudDummy = new Proxy(
    {},
    {
      get(_target, prop: string | symbol) {
        // Skip well-known JS-runtime accesses (Symbol probing) so the
        // throw is reserved for genuine method-call attempts.
        if (typeof prop === 'symbol') return undefined;
        logger.fatal(
          {
            event: 'composition_root_bug',
            caller,
            accessedProperty: String(prop),
          },
          `[F6] composition root invariant violated — dummy executor property "${String(prop)}" accessed; only standalone-tx methods should reach this path`,
        );
        throw new Error(
          `standalone ${caller}: tx-bound property "${String(prop)}" invoked unexpectedly — composition root bug`,
        );
      },
    },
  );
  return makePinoAuditPort(loudDummy as unknown as TenantTx);
}
