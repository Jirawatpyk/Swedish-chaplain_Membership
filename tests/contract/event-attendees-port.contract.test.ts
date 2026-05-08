/**
 * F8 Phase 6 Wave C · T158a — `EventAttendeesPort` contract test.
 *
 * Per research.md R5 + spec FR-029a + tasks.md M2-audit-fix:
 * F8 ships a stub adapter (Wave G T054 `event-attendees-stub.ts`)
 * returning `isAvailable() === false` + `listAttendances() === []`.
 * When F6 (`/006-event-attendees` future PR) ships its real adapter,
 * F8 must accept it as a drop-in replacement — same input/output
 * shape, same null-vs-throw semantics. This contract test pins both
 * the stub conformance + the future-F6-real-adapter conformance to
 * the same contract surface.
 *
 * Test design: a single `describeContract(name, makePort)` factory
 * runs the same 6 contract assertions against any port implementation.
 * The Wave-C-shipping stub runs ALL 6 assertions; the future F6 real
 * adapter swaps `makePort` and runs the same 6 assertions. F8 is
 * future-proofed against silent contract drift when F6 ships.
 */
import { describe, expect, it } from 'vitest';
import { eventAttendeesStub } from '@/modules/renewals/infrastructure/event-attendees-stub';
import type { EventAttendeesPort } from '@/modules/renewals/application/ports/event-attendees-port';

function describeContract(
  name: string,
  makePort: () => EventAttendeesPort,
): void {
  describe(`EventAttendeesPort contract — ${name}`, () => {
    it('isAvailable() returns a boolean', () => {
      const port = makePort();
      const result = port.isAvailable();
      expect(typeof result).toBe('boolean');
    });

    it('listAttendances() returns a Promise<ReadonlyArray>', async () => {
      const port = makePort();
      const result = await port.listAttendances(
        'tenantA',
        '00000000-0000-0000-0000-00000000a158',
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it('listAttendances() accepts opts param without throwing', async () => {
      const port = makePort();
      const result = await port.listAttendances(
        'tenantA',
        '00000000-0000-0000-0000-00000000a158',
        { sinceIso: '2026-01-01T00:00:00Z', limit: 10 },
      );
      expect(Array.isArray(result)).toBe(true);
    });

    it('listAttendances() returns objects matching EventAttendanceRecord shape (when non-empty)', async () => {
      const port = makePort();
      const result = await port.listAttendances('tenantA', 'mem-1');
      // The stub always returns []; real F6 adapter may return rows.
      // Pin the row shape so a future drift fails the test.
      for (const row of result) {
        expect(typeof row.memberId).toBe('string');
        expect(typeof row.attendedAt).toBe('string');
        expect(typeof row.eventId).toBe('string');
        expect(typeof row.eventType).toBe('string');
        // attendedAt MUST be ISO 8601 UTC (research.md R5)
        expect(row.attendedAt).toMatch(
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
        );
      }
    });

    it('listAttendances() with cross-tenant probe returns [] (tenant-scoped)', async () => {
      const port = makePort();
      // Whatever the implementation does for tenant binding (RLS for the
      // real adapter, no-op for the stub), a cross-tenant probe MUST NOT
      // leak rows from another tenant. Stub returns []; real adapter
      // must do the same per RLS.
      const result = await port.listAttendances(
        'definitely-not-a-real-tenant',
        'definitely-not-a-real-member',
      );
      expect(result).toEqual([]);
    });

    it('isAvailable() is consistent across calls (no flapping)', () => {
      const port = makePort();
      const r1 = port.isAvailable();
      const r2 = port.isAvailable();
      expect(r1).toBe(r2);
    });
  });
}

// Wave C — current production binding is the stub.
describeContract('event-attendees-stub (Wave C)', () => eventAttendeesStub);

describe('Stub-specific assertions', () => {
  it('isAvailable() returns false (FR-029a fallback path active)', () => {
    expect(eventAttendeesStub.isAvailable()).toBe(false);
  });

  it('listAttendances() returns [] for any tenant/member', async () => {
    const a = await eventAttendeesStub.listAttendances('tenantA', 'mem-a');
    const b = await eventAttendeesStub.listAttendances('tenantB', 'mem-b');
    expect(a).toEqual([]);
    expect(b).toEqual([]);
  });
});

// Future F6 real adapter — wire this once the F6 EventCreate integration
// PR ships. The contract surface stays identical; F8 swaps the binding
// in `renewals-deps.ts` and the same 6 assertions guarantee no
// regression. Currently skipped (no real adapter available).
describe.skip('future F6 real-adapter contract conformance', () => {
  // describeContract(
  //   'f6-event-attendees-bridge',
  //   () => makeF6EventAttendeesBridge(tenant),
  // );
  it.skip('placeholder — wire once F6 ships', () => {});
});
