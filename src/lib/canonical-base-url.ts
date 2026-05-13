/**
 * `canonical-base-url` — defence-in-depth helper that validates an
 * inbound `Host` header against the `APP_BASE_URL` +
 * `APP_ALLOWED_ORIGINS` allowlist before composing a webhook URL.
 *
 * Round 2 T-Gap2 (2026-05-13) extracted this from
 * `src/app/api/admin/integrations/eventcreate/_lib/role-violation-audit.ts`
 * so the unit test (`tests/unit/events/webhook-base-url-allowlist.test.ts`)
 * can mock `@/lib/env` without dragging in the DB-client + events-
 * barrel module-load chain. Pure presentation logic; zero
 * infrastructure imports.
 *
 * Why it matters (H4 from Round 1 review):
 *   Production behind Vercel terminates at a fixed hostname, but
 *   staging / preview deployments accept arbitrary `Host` headers.
 *   Without validation, an admin on staging could be tricked into
 *   copying a spoofed webhook URL into Zapier — and the test-webhook
 *   POST would then exfiltrate signed traffic to the attacker.
 *
 * Behaviour:
 *   - Inbound matches `APP_BASE_URL` origin → return verbatim.
 *   - Inbound in `APP_ALLOWED_ORIGINS` → return verbatim.
 *   - Off allowlist → return canonical `APP_BASE_URL` + log warn.
 *   - Malformed URL → return canonical (catch).
 *   - Null host (header variant) → return canonical early.
 */
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';

// Round 2 simplifier P4 — allowlist Set built once at module load.
// `env.app.{baseUrl,allowedOrigins}` are zod-validated at boot and
// frozen for the process lifetime.
const CANONICAL_ORIGIN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  new URL(env.app.baseUrl).origin,
  ...env.app.allowedOrigins.map((origin: string) => {
    try {
      return new URL(origin).origin;
    } catch {
      return origin;
    }
  }),
]);

/**
 * Validate a candidate base URL against the canonical allowlist.
 *
 * @param candidate — the inbound base URL (origin + scheme) to verify
 * @param surface — short label included in the warn log so SREs can
 *                  distinguish admin-API vs RSC-page misuse
 */
export function assertCanonicalBaseUrl(
  candidate: string,
  surface: string,
): string {
  let candidateOrigin: string;
  try {
    candidateOrigin = new URL(candidate).origin;
  } catch {
    return env.app.baseUrl;
  }
  if (CANONICAL_ORIGIN_ALLOWLIST.has(candidateOrigin)) {
    return candidateOrigin;
  }
  logger.warn(
    {
      event: 'f6_webhook_base_url_off_allowlist',
      candidateOrigin,
      surface,
    },
    '[F6] inbound Host header off allowlist — falling back to APP_BASE_URL',
  );
  return env.app.baseUrl;
}

/**
 * RSC server-component variant — no `NextRequest` available, so
 * accepts the proto + host header values directly.
 */
export function assertCanonicalBaseUrlFromHeaders(
  proto: string | null,
  host: string | null,
): string {
  const scheme = proto ?? 'https';
  if (!host) return env.app.baseUrl;
  return assertCanonicalBaseUrl(`${scheme}://${host}`, '/page');
}
