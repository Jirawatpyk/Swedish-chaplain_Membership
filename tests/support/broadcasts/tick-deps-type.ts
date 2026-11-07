/**
 * Spec 143 (TT2) — the deps type every `buildAudienceTick` unit harness builds
 * its doubles against, and the audit double they share.
 *
 * The homomorphic mapped type keeps every value `unknown` and requires that
 * every required key of `BuildAudienceTickDeps` exists, so a port added to the
 * use case fails each harness at compile time instead of silently taking a
 * catch branch at runtime (a full annotation would force every double to
 * implement its whole port). Optional keys stay optional: with `unknown`
 * values a present key checks nothing.
 *
 * `audit` is the one exception: it is typed as the port the use case declares,
 * `BuildAudienceTickDeps['audit']`. The restart writes its deleted row through
 * `emitOnce`, and a double without it once compiled under `unknown` and ran the
 * silent lost-row branch. `makeTickAuditDouble` builds that port in full.
 */
import type { AudienceDeletedEmitInput, AuditEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import type { BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';

/** The audit port `buildAudienceTick` takes, derived so it follows the use case. */
export type TickAuditPort = BuildAudienceTickDeps['audit'];

export type TickHarnessDeps = { [K in keyof BuildAudienceTickDeps]: unknown } & {
  readonly audit: TickAuditPort;
};

/** One audit row as the harnesses assert it: the event type and a copy of its payload. */
export interface RecordedAuditRow {
  readonly eventType: string;
  readonly payload: Record<string, unknown>;
}

export type TickAuditDouble = TickAuditPort & {
  /** Every row the default `emit` saw, in order. */
  readonly emitted: RecordedAuditRow[];
  /** Every row the default `emitOnce` saw, in order (each answered true: written). */
  readonly emittedOnce: RecordedAuditRow[];
};

function notUsedByTheTick(method: string): never {
  throw new Error(`makeTickAuditDouble: audit.${method} is not used by the tick; give the double an override if it now is`);
}

/**
 * A fully typed audit double for a tick harness. The default `emit` and
 * `emitOnce` record into `emitted` / `emittedOnce`, and `emitOnce` answers
 * true. `emitTyped`, `emitMany` and `emitManyTyped` throw, so a tick that
 * starts calling one fails its tests loudly instead of passing on a no-op.
 *
 * An override replaces a method as given. Overrides stay plain properties of
 * the returned object, so an override's `this` is the double and a harness may
 * reassign `emit` after construction.
 */
export function makeTickAuditDouble(overrides: Partial<TickAuditPort> = {}): TickAuditDouble {
  const emitted: RecordedAuditRow[] = [];
  const emittedOnce: RecordedAuditRow[] = [];
  return {
    emitted,
    emittedOnce,
    async emit(_tx: unknown, e: AuditEmitInput) {
      emitted.push({ eventType: e.eventType, payload: { ...e.payload } });
    },
    async emitOnce(_tx: unknown, e: AudienceDeletedEmitInput) {
      emittedOnce.push({ eventType: e.eventType, payload: { ...e.payload } });
      return true;
    },
    emitTyped: async () => notUsedByTheTick('emitTyped'),
    emitMany: async () => notUsedByTheTick('emitMany'),
    emitManyTyped: async () => notUsedByTheTick('emitManyTyped'),
    ...overrides,
  };
}
