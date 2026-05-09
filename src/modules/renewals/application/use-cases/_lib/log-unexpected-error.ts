/**
 * F8 Phase 8 R8 IMP-B + S-3 close — shared helper for the outer
 * catch in escalation-task use-cases.
 *
 * Why: the 4 use-cases (`{create,complete,skip,reassign}-escalation-
 * task.ts`) had verbatim 8-line `logger.error({err, tenantId, taskId,
 * correlationId}, '[X] unexpected error → server_error')` blocks
 * before `return err({kind:'server_error'})`. This helper:
 *   - Centralises the log shape (one source of truth for the
 *     `server_error` log tag).
 *   - Avoids double-logging when the inner audit-emit catch already
 *     logged at warn-level (IMP-B). Inner audit-emit failures are
 *     logger.warn (breadcrumb-only — outer catch's logger.error
 *     becomes the canonical Sentry-alerting incident).
 *   - Net delta: ~−14 LOC across the 4 sites.
 *
 * Usage in the outer catch:
 * ```ts
 * } catch (e) {
 *   if (e instanceof EscalationTaskNotFoundError) return err({kind:'task_not_open'});
 *   logUnexpectedError('complete-escalation-task', e, {
 *     tenantId: input.tenantId,
 *     taskId: input.taskId,
 *     correlationId: input.correlationId,
 *   });
 *   return err({kind:'server_error', message: e instanceof Error ? e.message : String(e)});
 * }
 * ```
 */
import { logger } from '@/lib/logger';

export function logUnexpectedError(
  useCaseLabel: string,
  e: unknown,
  ctx: Record<string, string | null | undefined>,
): void {
  logger.error(
    {
      err: e instanceof Error ? e : new Error(String(e)),
      ...ctx,
    },
    `[${useCaseLabel}] unexpected error → server_error`,
  );
}
