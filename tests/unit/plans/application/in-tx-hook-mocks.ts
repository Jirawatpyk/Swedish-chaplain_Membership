/**
 * 126 #7 — test doubles for the plans in-tx audit hook.
 *
 * Plans use cases now hand each repo write an `afterWrite` hook that
 * appends the audit row inside the write's tx (`AuditPort.recordInTx`).
 * These helpers make the unit-test doubles behave like the real adapters:
 *
 *   - `hooked(impl)` — a repo-method mock that, after `impl` resolves, calls
 *     the trailing hook argument with a fake tx and what was written (the
 *     plan, the `deleted` plan, the clone summary, the transitioned row…),
 *     and lets a hook throw propagate — as the real repo's tx would.
 *   - `inTxAudit(stub)` — adds `recordInTx` delegating to the stub's
 *     `record`, so existing `audit.record` assertions keep holding.
 */
import { vi } from 'vitest';
import type { AuditPort } from '@/modules/plans/application/ports';

function writtenOf(result: unknown): unknown {
  if (result === null || result === undefined) return undefined;
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    if ('kind' in r) return r.kind === 'deleted' ? r.plan : undefined;
    if ('ok' in r && typeof r.ok === 'boolean') return r.ok ? r.value : undefined;
  }
  return result;
}

export function hooked<A extends unknown[], R>(impl: (...args: A) => Promise<R>) {
  return vi.fn(async (...args: A): Promise<R> => {
    const result = await impl(...args);
    const hook = args[args.length - 1];
    const written = writtenOf(result);
    if (typeof hook === 'function' && written !== undefined) {
      await (hook as (tx: unknown, w: unknown) => Promise<void>)({ __tx: true }, written);
    }
    return result;
  });
}

export function inTxAudit<T extends { record: (...args: never[]) => unknown }>(
  stub: T,
): T & Pick<AuditPort, 'recordInTx'> {
  const record = stub.record as unknown as (ctx: unknown, event: unknown) => unknown;
  return Object.assign(stub, {
    recordInTx: vi.fn((_tx: unknown, ctx: unknown, event: unknown) =>
      record(ctx, event),
    ) as unknown as AuditPort['recordInTx'],
  });
}
