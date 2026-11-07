/**
 * Spec 143 (TT2) — `TickHarnessDeps` requires the audit port the tick declares,
 * and `makeTickAuditDouble` builds it.
 *
 * The restart writes its deleted row through `audit.emitOnce`. An audit double
 * without it used to compile in every harness (their values were `unknown`),
 * and the cell then ran the silent lost-row branch. The audit slot is now
 * `BuildAudienceTickDeps['audit']`, so a hand-picked partial double does not
 * compile. The `@ts-expect-error` checks are type-level: `pnpm typecheck` fails
 * when one no longer has an error to expect. The runtime cells pin the shared
 * double: it records, and the methods the tick does not use throw.
 */
import { describe, expect, it } from 'vitest';

import type { AudienceDeletedEmitInput, AuditEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import { makeTickAuditDouble, type TickHarnessDeps } from '../../../support/broadcasts/tick-deps-type';

/** Every port but `audit`, as a harness would stub them. */
const OTHER_PORTS = {
  tenant: {},
  broadcastsRepo: {},
  broadcastsGateway: {},
  brandChrome: {},
  clock: {},
  fromEmail: 'noreply@example.test',
  tenantDisplayName: 'Example',
  locale: 'en',
  resolveRecipients: async () => null,
  membersBridge: {},
  emailTransactional: {},
  plansBridge: {},
  sendStanding: {},
  orphans: {},
  tickBudget: {},
} as const;

const emit = async (_tx: unknown, _e: AuditEmitInput): Promise<void> => undefined;
const emitOnce = async (_tx: unknown, _e: AudienceDeletedEmitInput): Promise<boolean> => true;

describe('spec 143 TT2 — TickHarnessDeps requires the whole tick audit port', () => {
  it('the shared double compiles; a partial double, or a wrong emitOnce, does not', () => {
    const full: TickHarnessDeps = { ...OTHER_PORTS, audit: makeTickAuditDouble() };

    // @ts-expect-error — a hand-picked double without emitTyped is not the port.
    const noEmitTyped: TickHarnessDeps = { ...OTHER_PORTS, audit: { emit, emitOnce } };

    // @ts-expect-error — the audit double lacks emitOnce.
    const noEmitOnce: TickHarnessDeps = { ...OTHER_PORTS, audit: { emit } };

    // @ts-expect-error — emitOnce answers void, not whether the row was written.
    const wrongEmitOnce = makeTickAuditDouble({ emitOnce: async () => undefined });

    expect([full, noEmitTyped, noEmitOnce, wrongEmitOnce]).toHaveLength(4);
  });

  it('records emit and emitOnce, and the methods the tick does not use throw', async () => {
    const audit = makeTickAuditDouble();
    await audit.emit(null, { eventType: 'broadcast_send_started', payload: { a: 1 } } as unknown as AuditEmitInput);
    const wrote = await audit.emitOnce(null, {
      eventType: 'broadcast_audience_deleted',
      payload: { resend_audience_id: 'seg-1' },
    } as unknown as AudienceDeletedEmitInput);

    expect(wrote).toBe(true);
    expect(audit.emitted).toEqual([{ eventType: 'broadcast_send_started', payload: { a: 1 } }]);
    expect(audit.emittedOnce).toEqual([{ eventType: 'broadcast_audience_deleted', payload: { resend_audience_id: 'seg-1' } }]);
    await expect(audit.emitTyped(null, {} as never)).rejects.toThrow(/audit\.emitTyped is not used by the tick/);
    await expect(audit.emitMany?.(null, [])).rejects.toThrow(/audit\.emitMany is not used by the tick/);
    await expect(audit.emitManyTyped?.(null, [])).rejects.toThrow(/audit\.emitManyTyped is not used by the tick/);
  });

  it('an override replaces the default, and its this is the double', async () => {
    const seen: string[] = [];
    const audit = makeTickAuditDouble({
      async emitOnce(this: { emit(tx: unknown, e: AuditEmitInput): Promise<void> }, tx, e) {
        await this.emit(tx, { eventType: e.eventType, payload: { ...e.payload } } as unknown as AuditEmitInput);
        return false;
      },
    });
    audit.emit = async (_tx, e) => void seen.push(e.eventType);

    const wrote = await audit.emitOnce(null, { eventType: 'broadcast_audience_deleted', payload: {} } as unknown as AudienceDeletedEmitInput);

    expect(wrote).toBe(false);
    expect(seen).toEqual(['broadcast_audience_deleted']);
    expect(audit.emittedOnce).toEqual([]);
  });
});
