/**
 * Feature-flag helpers (T036).
 *
 * Thin wrapper around `env.features.*` so callers don't need to know
 * the shape of the env object and future flags have a single import
 * target. The flag values are parsed at boot by `env.ts` (zod) so a
 * malformed string is a boot-time failure, not a runtime surprise.
 */
import { env } from './env';

export function isF3Enabled(): boolean {
  return env.features.f3Members;
}
