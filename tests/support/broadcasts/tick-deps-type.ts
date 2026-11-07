/**
 * Spec 143 (TT2) — the deps type every `build-audience-tick*.test.ts` harness
 * builds its doubles against.
 *
 * The homomorphic mapped type keeps every value `unknown` and requires only
 * that every key of `BuildAudienceTickDeps` EXISTS, the optional ones too
 * (`-?`, review round 1), so a port added to the use case fails each harness
 * at compile time instead of silently taking a catch branch at runtime (a full
 * annotation would force every double to implement its whole port).
 *
 * `audit` is the one exception: the restart writes its deleted row through
 * `emitOnce`, and a double without it compiled under `unknown` and ran the
 * silent lost-row branch (spec 142 review round 3). So the audit double must
 * be `emit` plus the whole `AudienceDeletedAuditPort`, in every harness.
 */
import type { AudienceDeletedAuditPort, AuditPort } from '@/modules/broadcasts/application/ports/audit-port';
import type { BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';

export type TickHarnessDeps = { [K in keyof BuildAudienceTickDeps]-?: unknown } & {
  readonly audit: Pick<AuditPort, 'emit'> & AudienceDeletedAuditPort;
};
