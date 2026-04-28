/**
 * Staff-review R2 R015 (2026-04-28) — type-exhaustiveness assertion on
 * F5 audit discriminated-union mapped type.
 *
 * Guards against the silent regression where a future commit adds a new
 * literal to `F5AuditEventType` without also extending
 * `F5AuditPayloadByType` and `F5_AUDIT_RETENTION_YEARS`. The compile-time
 * `_Check` types below force `tsc --noEmit` to fail if the maps drift.
 *
 * No runtime behaviour — vitest exists only so the file is included in
 * the test graph and `pnpm typecheck` covers it.
 */
import { describe, it, expect } from 'vitest';
import {
  F5_AUDIT_RETENTION_YEARS,
  type F5AuditEventType,
  type F5AuditPayloadByType,
} from '@/modules/payments/application/ports/audit-port';

// ---------------------------------------------------------------------------
// Compile-time exhaustiveness guards.
//
// If any literal in F5AuditEventType is missing from F5AuditPayloadByType,
// `Exclude<F5AuditEventType, keyof F5AuditPayloadByType>` evaluates to a
// non-`never` union. The `extends never ? true : false` resolves to
// `false`, and the type alias `_PayloadCheck = true` no longer holds —
// triggering TS2322.
// ---------------------------------------------------------------------------

type _PayloadExhaustive =
  Exclude<F5AuditEventType, keyof F5AuditPayloadByType> extends never ? true : false;

// If retention map drops any literal, this fails too. Record<K, V> requires
// every K to be present.
type _RetentionExhaustive =
  Exclude<F5AuditEventType, keyof typeof F5_AUDIT_RETENTION_YEARS> extends never
    ? true
    : false;

// The two assertions below are the actual gate — TS will error here if the
// maps drift.
const _payloadOk: _PayloadExhaustive = true;
const _retentionOk: _RetentionExhaustive = true;

describe('F5 audit-payload + retention map exhaustiveness (R015)', () => {
  it('every F5AuditEventType has a F5AuditPayloadByType entry (compile-time)', () => {
    // Runtime echo of the compile-time guard — keeps the file in the
    // test graph so `pnpm test:coverage` includes it.
    expect(_payloadOk).toBe(true);
  });

  it('every F5AuditEventType has a F5_AUDIT_RETENTION_YEARS entry (compile-time)', () => {
    expect(_retentionOk).toBe(true);
  });

  it('every F5_AUDIT_RETENTION_YEARS value is exactly 5 or 10 (runtime)', () => {
    // Defense-in-depth: if a future edit accidentally widens the value
    // type to `number`, the runtime check still catches it.
    for (const [eventType, years] of Object.entries(F5_AUDIT_RETENTION_YEARS)) {
      expect([5, 10]).toContain(years);
      expect(typeof eventType).toBe('string');
    }
  });
});
