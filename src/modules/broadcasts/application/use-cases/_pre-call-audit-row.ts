/**
 * Spec 142 (AO4) — the one envelope for an append-only audit row written
 * BEFORE an irreversible Resend call (`.claude/rules/modules/broadcasts.md`,
 * "Gates and audit rows for Resend calls"). Its callers: the audience rows
 * (`_audience-audit.ts`, spec 139 s2) and the pre-send unverifiable-count row
 * (`recordUnverifiableCount` in `build-audience-tick.ts`, spec 140 s4).
 *
 * The policy, so no caller reimplements it:
 *   - the row is written in its OWN tenant-bound `withTx` (never a null tx: a
 *     pool connection carries no `app.current_tenant`, where RLS writes
 *     nothing); `write` runs inside it and answers `'written'` or why it wrote
 *     nothing (a dedupe skip, say);
 *   - written → `broadcasts_audit_emit_count{event_type}`;
 *   - an adapter invariant error (`isAdapterInvariantError`: a wiring bug) is
 *     handed to `onInvariant` and RETHROWN, so the call is never made;
 *   - any other error is a lost row: handed to `onLost`, counted on
 *     `broadcasts_audit_emit_failed_total`, and answered as `'lost'`, so the
 *     caller makes the call anyway (refusing a call on an audit blip would
 *     kill a legitimate send or delete). No alert backend is wired: the
 *     caller's log line and the counter are the control.
 *
 * The log lines are the caller's (`onInvariant` / `onLost`), because their
 * names and fields are pinned per site; a hook must not throw. What stays at
 * the caller: any re-gate after the row (it runs on every outcome), and any
 * dedupe read inside `write`.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { broadcastsMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';

import type { F7AuditEventType } from '../ports/audit-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import { isAdapterInvariantError } from './_safe-audit-emit';

/** The ports the envelope needs. */
export interface PreCallAuditRowDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<BroadcastsRepo, 'withTx'>;
}

/** The caller's log lines for the two failure arms. */
export interface PreCallAuditRowHooks {
  /** Before the rethrow of an adapter invariant error. */
  readonly onInvariant: (e: unknown) => void;
  /** Before the failure is counted and answered as `'lost'`. */
  readonly onLost: (e: unknown) => void;
}

/**
 * Write one pre-call audit row in its own tx; answers what happened. Never
 * throws, except an adapter invariant error (rethrown after `onInvariant`).
 */
export async function writePreCallAuditRow<NoRow extends string>(
  deps: PreCallAuditRowDeps,
  eventType: F7AuditEventType,
  write: (tx: unknown) => Promise<'written' | NoRow>,
  hooks: PreCallAuditRowHooks,
): Promise<'written' | NoRow | 'lost'> {
  let result: 'written' | NoRow;
  try {
    result = await deps.broadcastsRepo.withTx(write);
  } catch (e) {
    // A wiring bug fails closed: nothing has been sent or deleted yet.
    if (isAdapterInvariantError(e)) {
      hooks.onInvariant(e);
      throw e;
    }
    hooks.onLost(e);
    broadcastsMetrics.auditEmitFailed(eventType, deps.tenant.slug);
    return 'lost';
  }
  if (result === 'written') broadcastsMetrics.auditEmitCount(deps.tenant.slug, eventType);
  return result;
}
