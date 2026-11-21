/**
 * Shared DB-error wrapper for the F6 Infrastructure layer.
 *
 * Postgres `pg-protocol` error messages include table names, column
 * names, constraint names and bound parameters, so none of that text
 * reaches Application-layer Result types or audit-log payloads: the
 * Result carries only the error CLASS (`errKind`, #739 B3b).
 *
 * Callers log the error's class and codes (`...errLogFields(e)`) at
 * the catch site, never its message or stack: a driver error's text
 * quotes bound parameters (#740, docs/observability.md § Log hygiene).
 *
 * Constitution Principle I sub-clause 4 (audit + log hygiene): no
 * Postgres identifiers in user-facing or audit-log error payloads.
 */

import { logger } from '@/lib/logger';
import { errClassWithCode, errKind, errLogFields } from '@/lib/log-id';
import { GraceStateInvariantError } from '../domain/tenant-webhook-config';
import { MatchResolutionInvariantError } from '../domain/event-registration';

/**
 * Single catch-block helper for the F6 repository adapters.
 *
 * Each adapter catch site collapses to:
 *
 *   } catch (e) {
 *     return err(wrapRepoError('events', e));
 *   }
 *
 * Logs the error class + SQLSTATE via `logger.error` with
 * `event: 'f6_repo_db_error'` (never the message or stack, #740) AND
 * returns the error class as the outbound `message` (#739 B3b). The
 * `repoLabel` parameter narrows
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
    | 'tenantWebhookConfig'
    | 'csvImportRecords',
  e: unknown,
): { readonly kind: 'db_error'; readonly message: string } {
  // R5.1 / Round 4 C-1 — re-throw read-time invariant violations BEFORE
  // sanitisation. Without this guard, an `asGraceState` or
  // `asMatchResolutionView` throw would be silently swallowed into a
  // generic `Result.err({kind:'db_error', message:'<class>'})` —
  // forensically indistinguishable from a Neon connectivity blip.
  // The dedicated error classes preserve their `name` + structured
  // fields up to the route handler, which surfaces the violation as
  // an unhandled-error 500 + structured pino.error (the P1 alert at
  // `eventcreate_match_resolution_invariant_violation_total` + future
  // GraceState equivalent will still fire from the upstream catch
  // site that emits the metric before re-throwing).
  if (
    e instanceof GraceStateInvariantError ||
    e instanceof MatchResolutionInvariantError
  ) {
    throw e;
  }
  logger.error(
    {
      event: 'f6_repo_db_error',
      repo: repoLabel,
      ...errLogFields(e),
    },
    `[F6 ${repoLabel} repository] DB error`,
  );
  return { kind: 'db_error', message: errClassWithCode(e) };
}
