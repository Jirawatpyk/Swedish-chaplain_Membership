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
 *
 * Naming glossary:
 *   - Port methods on `F6AuditPort`: `emit` / `emitRolledBack` /
 *     `emitStandalone`.
 *   - Deps fields on `IngestWebhookAttendeeDeps`: `runInTenantTx` /
 *     `emitRolledBackStandalone` / `emitStandalone`. The deps wrappers
 *     call the port's standalone-tx methods (`emitRolledBack`,
 *     `emitStandalone`) via the dummy-executor pattern below.
 *     `emitStandalone` is intentionally the same name on both layers
 *     since the wrapper is a thin delegate to the port method.
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
 * fails on ANY interaction (`get` / `has` / `set` / `apply`). Used by
 * the standalone composition-root paths (`emitRolledBackStandalone` +
 * `emitStandalone`) where the tx argument is intentionally unused
 * because the port's standalone methods use root `db.transaction`
 * internally.
 *
 * The Proxy is strictly tighter than a single `{ execute }` stub: any
 * future patch to `pino-audit-port` that probes the executor for a
 * new method (`'select' in executor`, `executor.foo = …`,
 * `executor(args)`, …) gets the same fatal-log-plus-throw treatment
 * — no silent `undefined`, no silent write-to-empty-object, no
 * generic `TypeError`.
 */
function makeLoudDummyExecutorPort(caller: string) {
  const loudFail = (op: string, prop: string | symbol): never => {
    const safeProp = typeof prop === 'symbol' ? prop.toString() : String(prop);
    logger.fatal(
      {
        event: 'composition_root_bug',
        caller,
        operation: op,
        accessedProperty: safeProp,
      },
      `[F6] composition root invariant violated — dummy executor "${op}" on "${safeProp}"; only standalone-tx methods should reach this path`,
    );
    throw new Error(
      `standalone ${caller}: dummy executor "${op}" on "${safeProp}" invoked unexpectedly — composition root bug`,
    );
  };
  const loudDummy = new Proxy(
    {},
    {
      get(_target, prop): unknown {
        // Skip Symbol probing (Promise inspector, util.inspect, etc.) —
        // reserve loud failure for genuine string-keyed accesses.
        if (typeof prop === 'symbol') return undefined;
        return loudFail('get', prop);
      },
      has(_target, prop): boolean {
        return loudFail('has', prop);
      },
      set(_target, prop): boolean {
        return loudFail('set', prop);
      },
      apply(_target, _thisArg, _argList): unknown {
        return loudFail('apply', '<call>');
      },
    },
  );
  return makePinoAuditPort(loudDummy as unknown as TenantTx);
}
