/**
 * Shared DB-error sanitiser for F6 Infrastructure layer.
 *
 * Postgres `pg-protocol` error messages include table names, column
 * names, constraint names, and other schema-identifier metadata that
 * are useful for SRE debugging but should never reach Application-
 * layer Result types or audit-log payloads. This helper strips those
 * identifiers + caps the string length for safe propagation.
 *
 * E3 fix: Phase 3 audit-port.ts had this
 * helper inline; Phase 4 repo adapters forgot to apply the same
 * sanitisation. Extracted here for reuse.
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
 * Simp#1 round-3: collapse the identical 14-line
 * try/catch boilerplate previously duplicated across 9 sites in the
 * F6 repository adapters. Each site did:
 *
 *   } catch (e) {
 *     logger.error({event:'f6_repo_db_error', err: {name,message,stack}}, ...);
 *     return err({kind:'db_error', message: sanitizeDbErrorMessage(e)});
 *   }
 *
 * Now collapsed to:
 *
 *   } catch (e) {
 *     return err(wrapRepoError('events', e));
 *   }
 *
 * Preserves both server-side log fidelity (full error.name + message +
 * stack) AND outbound payload sanitisation (Postgres identifiers
 * stripped, message capped at 200 chars). The `repoLabel` parameter
 * narrows the log line to the specific repo (`'events'` or
 * `'registrations'`) so SREs can filter alerts by adapter origin.
 *
 * @param repoLabel — repo identifier ("events" / "registrations") for log filtering
 * @param e — unknown thrown value caught in a repo adapter
 * @returns the `db_error` Result variant (caller wraps in `err(...)`)
 */
export function wrapRepoError(
  repoLabel: 'events' | 'registrations',
  e: unknown,
): { readonly kind: 'db_error'; readonly message: string } {
  logger.error(
    {
      event: 'f6_repo_db_error',
      repo: repoLabel,
      err:
        e instanceof Error
          ? { name: e.name, message: e.message, stack: e.stack }
          : String(e),
    },
    `[F6 ${repoLabel} repository] DB error`,
  );
  return { kind: 'db_error', message: sanitizeDbErrorMessage(e) };
}
