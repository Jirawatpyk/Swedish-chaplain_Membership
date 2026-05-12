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
 */
import { asTenantContext } from '@/modules/tenants';
import { runInTenant } from '@/lib/db';
import type {
  IngestWebhookAttendeeDeps,
  TxScopedPorts,
} from '../application/ingest-webhook-attendee';
import { makeDrizzleEventsRepository } from './drizzle-events-repository';
import { makeDrizzleRegistrationsRepository } from './drizzle-registrations-repository';
import { makeDrizzleIdempotencyStore } from './drizzle-idempotency-store';
import { makeDrizzleAttendeeMatcher } from './drizzle-attendee-matcher';
import { makePinoAuditPort } from './pino-audit-port';

/**
 * Default deps for the F6 webhook ingest path. Wires:
 *   - `runInTenantTx` → `@/lib/db.runInTenant` with all Drizzle adapter
 *     instances bound to the inner tx + audit emitter bound to the
 *     same tx so `audit.emit` commits atomically.
 *   - `emitRolledBackStandalone` → a fresh `makePinoAuditPort(...)`
 *     instance whose `emitRolledBack` method uses root `db.transaction`
 *     internally for the FR-037 dual-write fallback.
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
      // The `emitRolledBack` method on the pino-audit-port uses root
      // `db.transaction` internally — its tx argument is unused on
      // that code path. We pass a dummy executor since we only invoke
      // `emitRolledBack` here. (If `emit` were invoked, the dummy
      // would crash — defensive: caller mistakes are LOUD.)
      const port = makePinoAuditPort({
        execute: () => {
          throw new Error(
            'standalone emitRolledBack: tx-bound `emit` invoked unexpectedly — composition root bug',
          );
        },
      } as unknown as Parameters<typeof makePinoAuditPort>[0]);
      return port.emitRolledBack(entry);
    },
  };
}
