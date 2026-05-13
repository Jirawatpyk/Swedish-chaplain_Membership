/**
 * Stack-trace path redactor — shared utility (round-6 W2 staff-review
 * fix 2026-05-13).
 *
 * Strips absolute filesystem paths and bundler-internal URLs from a
 * stack trace before persisting it to either:
 *   - the audit_log.payload JSONB column (`webhook_rolled_back` event,
 *     5-year retention), OR
 *   - pino log sinks (route-layer `safeEmitStandalone` catch).
 *
 * Without redaction, Vercel container paths (`/var/task/...`), macOS
 * dev paths (`/private/var/...`), workspace paths (`/Users/...`,
 * `/home/...`), `node_modules/...` package layout, and Next.js
 * `webpack-internal:///` URLs would leak deployment-filesystem
 * structure into observability surfaces with broader access than the
 * SRE pool.
 *
 * Pure string transform — lives in `@/lib/` so both Infrastructure
 * adapters (`sanitize-db-error.ts wrapRepoError`) AND Application
 * use-cases (`ingest-webhook-attendee.ts webhook_rolled_back` audit
 * emit) can import it without violating Clean Architecture
 * (Constitution Principle III): Application is permitted to depend on
 * `@/lib/*` utilities; it is NOT permitted to depend on
 * `infrastructure/*`.
 */

const STACK_CAP = 4_000;

export function redactStack(stack: string | undefined): string | undefined {
  if (stack === undefined) return undefined;
  return (
    stack
      // Strip absolute Linux/Vercel container paths (`/var/task/...`,
      // `/var/runtime/...`, etc.), absolute Windows dev paths, and
      // `/private/` (macOS dev `/private/var` etc.) + any
      // `node_modules` prefix (leaks installed-package paths +
      // workspace layout).
      .replace(
        /(?:[a-z]:)?[\\\/](?:var|usr|home|opt|tmp|root|users|private|node_modules)[\\\/][\w.\-\\\/]+/gi,
        '[redacted-path]',
      )
      // Strip Next.js `webpack-internal:///` URLs which leak the
      // dev-bundler internal module graph.
      .replace(/webpack-internal:\/\/[^\s)]+/g, '[redacted-webpack-internal]')
      // Strip remaining `file://` URLs.
      .replace(/file:\/\/[^\s)]+/g, '[redacted-file-url]')
      .slice(0, STACK_CAP)
  );
}
