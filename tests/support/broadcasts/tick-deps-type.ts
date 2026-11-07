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
import {
  AuditPortInvariantError,
  type AudienceDeletedEmitInput,
  type AuditEmitInput,
} from '@/modules/broadcasts/application/ports/audit-port';
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
  /** Every row `emit` wrote, in order: the default's, or an override's that resolved. */
  readonly emitted: RecordedAuditRow[];
  /** Every row `emitOnce` wrote, in order: each call that answered true. */
  readonly emittedOnce: RecordedAuditRow[];
};

/** What the tick would meet in production: the error its audit catches rethrow. */
function notUsedByTheTick(method: string): never {
  throw new AuditPortInvariantError(
    method,
    `makeTickAuditDouble: audit.${method} is not used by the tick; give the double an override if it now is`,
  );
}

/**
 * A fully typed audit double for a tick harness.
 *
 * `emitted` and `emittedOnce` hold the rows the port reported written, with or
 * without an override: `emit` records once its body resolves, `emitOnce` once
 * it answers true. A "no audit row" assertion therefore reads the calls the
 * tick made, never an array an override left empty.
 *
 * The defaults behave as the adapter does. `emit` refuses
 * `broadcast_audience_deleted` with an `AuditPortInvariantError` (that row is
 * written only through `emitOnce`). `emitOnce` answers false, and records
 * nothing, when a row for the same (tenantId, resend_audience_id) is already
 * written, as migration 0328's unique index does. `emitTyped`, `emitMany` and
 * `emitManyTyped` throw an `AuditPortInvariantError`, which the tick's audit
 * catches rethrow, so a tick that starts calling one fails its tests loudly.
 *
 * An `emit` or `emitOnce` override replaces the body; its return value and
 * its throw are kept. Every method is a plain property of the returned object,
 * so an override's `this` is the double (`this.emit` records as well), and a
 * harness may reassign a method after construction; the reassigned one
 * records only if it calls the method it replaced.
 */
export function makeTickAuditDouble(overrides: Partial<TickAuditPort> = {}): TickAuditDouble {
  const { emit: emitOverride, emitOnce: emitOnceOverride, ...rest } = overrides;
  const emitted: RecordedAuditRow[] = [];
  const emittedOnce: RecordedAuditRow[] = [];
  const writtenOnceKeys = new Set<string>();
  const onceKey = (e: AudienceDeletedEmitInput) => JSON.stringify([e.tenantId, e.payload.resend_audience_id]);
  return {
    emitted,
    emittedOnce,
    async emit(tx: unknown, e: AuditEmitInput) {
      if (emitOverride !== undefined) {
        await emitOverride.call(this, tx, e);
      } else if ((e.eventType as string) === 'broadcast_audience_deleted') {
        throw new AuditPortInvariantError(e.eventType, 'written only through emitOnce (migration 0328).');
      }
      emitted.push({ eventType: e.eventType, payload: { ...e.payload } });
    },
    async emitOnce(tx: unknown, e: AudienceDeletedEmitInput) {
      let wrote: boolean;
      if (emitOnceOverride !== undefined) {
        wrote = await emitOnceOverride.call(this, tx, e);
      } else {
        const key = onceKey(e);
        wrote = !writtenOnceKeys.has(key);
        writtenOnceKeys.add(key);
      }
      if (wrote) emittedOnce.push({ eventType: e.eventType, payload: { ...e.payload } });
      return wrote;
    },
    emitTyped: async () => notUsedByTheTick('emitTyped'),
    emitMany: async () => notUsedByTheTick('emitMany'),
    emitManyTyped: async () => notUsedByTheTick('emitManyTyped'),
    ...rest,
  };
}
