/**
 * Spec 143 (TT2) — the deps type every `build-audience-tick*.test.ts` harness
 * builds its doubles against.
 *
 * The homomorphic mapped type keeps every value `unknown` and requires only
 * that every key of `BuildAudienceTickDeps` EXISTS, so a port added to the use
 * case fails each harness at compile time instead of silently taking a catch
 * branch at runtime (a full annotation would force every double to implement
 * its whole port).
 */
import type { BuildAudienceTickDeps } from '@/modules/broadcasts/application/use-cases/build-audience-tick';

export type TickHarnessDeps = { [K in keyof BuildAudienceTickDeps]: unknown };
