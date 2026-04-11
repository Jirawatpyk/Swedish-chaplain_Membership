/**
 * Tenant-context resolver — turns an incoming request into a validated
 * `TenantContext` brand.
 *
 * **F2 behaviour** (single-tenant SweCham deployment): returns a
 * constant `asTenantContext(env.tenant.slug)` for every request. The
 * slug is validated at boot by `src/lib/env.ts` against the same
 * `[a-z0-9-]{1,63}` pattern that `asTenantContext` enforces, so an
 * invalid `TENANT_SLUG` env var fails server startup rather than
 * surfacing as a runtime error mid-request.
 *
 * **F10 behaviour** (multi-tenant rollout): replace the body of
 * `resolveTenantFromRequest` with subdomain / custom-domain / signed
 * session-claim parsing. **Zero changes** are required anywhere else —
 * every F2+ use case already takes `TenantContext` as an explicit
 * dependency, so the resolver swap is a one-file PR. See
 * `specs/002-membership-plans/research.md § 1.1` for the migration
 * path.
 *
 * This file sits in `src/lib/**` which is on the Module side of the
 * Clean-Architecture barrel — it imports the type from the `tenants`
 * public barrel, not from the deep Domain file.
 */

import { asTenantContext, type TenantContext } from '@/modules/tenants';
import { env } from './env';

/**
 * Resolve the tenant for a given incoming request.
 *
 * F2: ignores the request entirely and returns the env-configured slug.
 * F10: will parse the request's host header / session claim.
 *
 * @param req — reserved for F10. Unused in F2; the parameter is kept
 *   on the signature so downstream callers don't need to change when
 *   F10 activates it.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function resolveTenantFromRequest(req?: Request): TenantContext {
  // `asTenantContext` re-validates the slug at the trust boundary. The
  // env validator already checked it at boot, so this call will never
  // throw in practice — it's defence in depth against a stale cached
  // env object or an accidental hot-patch.
  return asTenantContext(env.tenant.slug);
}
