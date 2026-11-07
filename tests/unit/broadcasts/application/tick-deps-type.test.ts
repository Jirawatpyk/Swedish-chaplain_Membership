/**
 * Spec 143 (TT2) — `TickHarnessDeps` requires the audit port the tick uses.
 *
 * The restart writes its deleted row through `audit.emitOnce`. An audit double
 * without it used to compile in every harness (their values were `unknown`),
 * and the cell then ran the silent lost-row branch. The checks here are
 * type-level: `pnpm typecheck` fails when a `@ts-expect-error` below no longer
 * has an error to expect. The runtime cell only keeps vitest from reporting
 * an empty file.
 */
import { describe, expect, it } from 'vitest';

import type { AudienceDeletedEmitInput, AuditEmitInput } from '@/modules/broadcasts/application/ports/audit-port';
import type { TickHarnessDeps } from '../../../support/broadcasts/tick-deps-type';

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

describe('spec 143 TT2 — TickHarnessDeps requires emit and emitOnce on audit', () => {
  it('an audit double with emit and emitOnce compiles; one without emitOnce, or with a wrong emitOnce, does not', () => {
    const full: TickHarnessDeps = { ...OTHER_PORTS, audit: { emit, emitOnce } };

    // @ts-expect-error — the audit double lacks emitOnce.
    const noEmitOnce: TickHarnessDeps = { ...OTHER_PORTS, audit: { emit } };

    // @ts-expect-error — emitOnce answers void, not whether the row was written.
    const wrongEmitOnce: TickHarnessDeps = { ...OTHER_PORTS, audit: { emit, emitOnce: async () => undefined } };

    expect([full, noEmitOnce, wrongEmitOnce]).toHaveLength(3);
  });
});
