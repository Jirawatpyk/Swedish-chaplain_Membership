/**
 * Spec 139 slice 2 (DA1–DA3) — the Art. 30 rows of the import leg's Resend
 * calls on a segment.
 *
 * `broadcast_audience_disclosed` records a recipient list handed to Resend
 * (tick 1, before `createContactImport`).
 *
 * Every row is written BEFORE its Resend call, in its own tenant-bound
 * `withTx` (never a null tx: that would take a pool connection with no
 * `app.current_tenant`, where RLS writes nothing), so it records a request,
 * not its outcome. On failure (the pre-send unverifiable row's pattern, spec
 * 140 s4):
 *   - an adapter invariant error (`isAdapterInvariantError`: a wiring bug)
 *     RETHROWS, so the call is never made;
 *   - any other error is a lost record: logged at ERROR with
 *     `severity: 'critical'` (`<prefix>.audience_audit_lost`) and counted on
 *     `broadcasts_audit_emit_failed_total`, and the caller makes the call
 *     anyway. So a missing row is not proof that nothing was disclosed. No
 *     alert backend is wired: the ERROR line and the counter are the control.
 *
 * Payloads carry ids and a count only, never an address or a hash.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';

import type { AuditPort, F7AuditPayloadShapes } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import { isAdapterInvariantError } from './_safe-audit-emit';

/** The ports a site needs to write an audience row. */
export interface AudienceAuditDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx'>;
  readonly audit: Pick<AuditPort, 'emit'>;
}

type AudienceEventType = 'broadcast_audience_disclosed';

/** The log-line prefix of the site that writes the row. */
export type AudienceAuditLogPrefix = 'broadcasts.audience_import';

/**
 * Write one row in its own tx. `build` runs inside that tx and answers the
 * payload, or `null` to write nothing. Answers whether a row was written.
 */
async function writeAudienceRow<E extends AudienceEventType>(
  deps: AudienceAuditDeps,
  eventType: E,
  logPrefix: AudienceAuditLogPrefix,
  ids: { readonly broadcastId: string | null; readonly resendAudienceId: string },
  summary: (payload: F7AuditPayloadShapes[E]) => string,
  build: (tx: unknown) => Promise<F7AuditPayloadShapes[E] | null>,
): Promise<'written' | 'skipped' | 'lost'> {
  let written = false;
  try {
    await deps.broadcastsRepo.withTx(async (tx) => {
      written = false;
      const payload = await build(tx);
      if (payload === null) return;
      await deps.audit.emit(tx, {
        eventType,
        tenantId: deps.tenant.slug,
        actorUserId: 'system:cron',
        summary: summary(payload),
        payload: { ...payload },
        requestId: null,
      });
      written = true;
    });
  } catch (e) {
    // A wiring bug fails closed: nothing has been sent or deleted yet.
    if (isAdapterInvariantError(e)) throw e;
    logger.error(
      {
        tenantId: deps.tenant.slug,
        broadcastId: ids.broadcastId,
        resendAudienceId: ids.resendAudienceId,
        eventType,
        err: errKind(e),
        severity: 'critical',
      },
      `${logPrefix}.audience_audit_lost`,
    );
    broadcastsMetrics.auditEmitFailed(eventType, deps.tenant.slug);
    return 'lost';
  }
  if (!written) return 'skipped';
  broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
  return 'written';
}

/**
 * DA1 — the recipient list is about to go to Resend. Never deduped: a row that
 * already holds a segment is restarted, so one segment id reaches the import
 * once. Never throws, except an adapter invariant error.
 */
export async function recordAudienceDisclosed(
  deps: AudienceAuditDeps,
  fields: {
    readonly broadcastId: string;
    readonly relatedMemberId: string;
    readonly resendAudienceId: string;
    readonly recipientCount: number;
  },
): Promise<void> {
  await writeAudienceRow(
    deps,
    'broadcast_audience_disclosed',
    'broadcasts.audience_import',
    fields,
    (p) => `Broadcast ${p.broadcast_id}: recipient list disclosure to Resend requested (${p.recipient_count} recipients)`,
    async () => ({
      broadcast_id: fields.broadcastId,
      related_member_id: fields.relatedMemberId,
      resend_audience_id: fields.resendAudienceId,
      recipient_count: fields.recipientCount,
      leg: 'import',
      actor_role: 'system',
    }),
  );
}
