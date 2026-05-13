/**
 * Shared DB-error sanitiser for F6 Infrastructure layer.
 *
 * Postgres `pg-protocol` error messages include table names, column
 * names, constraint names, and other schema-identifier metadata that
 * are useful for SRE debugging but should never reach Application-
 * layer Result types or audit-log payloads. This helper strips those
 * identifiers + caps the string length for safe propagation.
 *
 * Centralised here so both audit-port emit-error path and Drizzle
 * repo adapters share the same Postgres-identifier redaction regex.
 *
 * IMPORTANT: callers MUST log the FULL error (`e.message + e.stack`)
 * via `logger.error` at the catch site BEFORE passing the sanitised
 * string back to Application. Sanitisation protects the outbound
 * payload; server-side logs keep root-cause forensics.
 *
 * Constitution Principle I sub-clause 4 (audit + log hygiene): no
 * Postgres identifiers in user-facing or audit-log error payloads.
 */

import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';

const DB_ERROR_MESSAGE_CAP = 200;

export function sanitizeDbErrorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  // Single-pass regex strips both quoted-identifier (`"foo"`) and bare-
  // identifier (`foo`) forms after the canonical Postgres marker words.
  const stripped = raw.replace(
    /(table|column|constraint|relation|function|index|sequence|schema)\s+("[^"]+"|[a-z_][a-z0-9_]*)/gi,
    (_m, kind, ident) =>
      `${kind} ${ident.startsWith('"') ? '"[redacted]"' : '[redacted]'}`,
  );
  return stripped.slice(0, DB_ERROR_MESSAGE_CAP);
}

/**
 * Single catch-block helper for the F6 repository adapters.
 *
 * Each adapter catch site collapses to:
 *
 *   } catch (e) {
 *     return err(wrapRepoError('events', e));
 *   }
 *
 * Preserves both server-side log fidelity (full error.name + message +
 * stack via `logger.error` with `event: 'f6_repo_db_error'`) AND
 * outbound payload sanitisation (Postgres identifiers stripped,
 * message capped at 200 chars). The `repoLabel` parameter narrows
 * the log line to the specific repo so SREs can filter alerts by
 * adapter origin.
 *
 * @param repoLabel — repo identifier ("events" / "registrations") for log filtering
 * @param e — unknown thrown value caught in a repo adapter
 * @returns the `db_error` Result variant (caller wraps in `err(...)`)
 */
export function wrapRepoError(
  repoLabel:
    | 'events'
    | 'registrations'
    | 'idempotency'
    | 'matcher'
    | 'tenantWebhookConfig',
  e: unknown,
): { readonly kind: 'db_error'; readonly message: string } {
  logger.error(
    {
      event: 'f6_repo_db_error',
      repo: repoLabel,
      err:
        e instanceof Error
          ? {
              name: e.name,
              message: e.message,
              // Stack trace is bounded + filesystem-redacted before
              // emission. On Vercel Fluid Compute raw stacks contain
              // absolute container paths (`/var/task/...`) which would
              // expose deployment filesystem layout to any log viewer
              // with broader access than the SRE pool. Replace those
              // prefixes with `[redacted]` and cap total length.
              stack: redactStack(e.stack),
            }
          : String(e),
    },
    `[F6 ${repoLabel} repository] DB error`,
  );
  return { kind: 'db_error', message: sanitizeDbErrorMessage(e) };
}

// R6-W2 staff-review fix (2026-05-13): `redactStack` extracted to
// `@/lib/redact-stack` so Application use-cases can import it without
// violating Clean Architecture Principle III. This file re-imports
// for the `wrapRepoError` log path.
