/**
 * Round 3 R3.1.2 — pins `REDACT_ALLOWED_KEYS` against the real
 * `emitStandalone()` + `emitRolledBack()` caller payload graph as of
 * Round 3 audit. Adding a new audit event type with a new non-PII
 * forensic primitive REQUIRES updating BOTH the allowlist AND this test.
 *
 * For each shipped F6 audit event type whose payload reaches the
 * `pino.fatal` dual-write fallback, this test:
 *   1. Constructs a synthetic payload containing ALL declared fields
 *      (including PII fields like `attendeeEmail`, `errorMessage`).
 *   2. Asserts the redactor preserves only the allowlist fields and
 *      drops every PII / nested-object / array field.
 *   3. Verifies SRE forensic fields used by every real `emitStandalone`
 *      caller (5 webhook callers + role-violation + cross-tenant probe +
 *      csv-import-completed + override + cancellation-no-prior) are
 *      preserved — closes Round-2 R2-C1 (5 webhook callers) + Round-3
 *      C-1 (3+ missed callers including csv_import_cross_tenant_probe
 *      P-I cl.4 critical-severity event).
 */
import { describe, expect, it } from 'vitest';
import {
  REDACT_ALLOWED_KEYS,
  redactPayloadForFatalLog,
} from '@/modules/events/infrastructure/pino-audit-port';

const PII_FIELD_PROBES = [
  'attendeeEmail',
  'attendeeName',
  'attendeeCompany',
  'errorMessage',
  'errorStack',
  'reasonText',
  'rawRowExcerpt',
  'attendeeEmailLastFour',
  'matchedOnEmail',
  'phoneNumber',
];

describe('Phase H4.1 — redactPayloadForFatalLog exhaustive allowlist verification', () => {
  it('drops all known PII fields even when present in payload', () => {
    const payload = {
      severity: 'error',
      requestId: 'req-123',
      // PII fields that MUST be dropped:
      attendeeEmail: 'leak@example.com',
      attendeeName: 'Leaked Name',
      attendeeCompany: 'Leaked Corp',
      errorMessage: 'leaked stack-like message',
      errorStack: '/var/task/leaked.ts:42:1\n  at <anonymous>',
      reasonText: 'leaked admin justification',
      rawRowExcerpt: 'raw CSV row with email leak@example.com',
      attendeeEmailLastFour: '@cm',
      matchedOnEmail: 'leak@example.com',
      phoneNumber: '+1-555-LEAK',
    };
    const out = redactPayloadForFatalLog(payload);
    expect(out['severity']).toBe('error');
    expect(out['requestId']).toBe('req-123');
    for (const piiField of PII_FIELD_PROBES) {
      expect(out[piiField]).toBeUndefined();
    }
  });

  it('preserves all R2-C1 forensic fields used by real emitStandalone callers', () => {
    // From the 4 actual emitStandalone call sites (webhook route + admin
    // events route) — these are the SRE-visible fields during a DB-down
    // incident. Each must round-trip.
    const payload = {
      severity: 'warn',
      requestId: 'req-456',
      source: 'eventcreate',
      scope: 'partnership',
      errorName: 'PostgresError',
      failureStage: 'audit_emit',
      stage: 'precondition',
      rowNumber: 42,
      rowsCleared: 3,
      durationMs: 1234,
      registrationId: '11111111-2222-4333-8444-555555555555',
      eventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      matchType: 'member_contact',
      graceSecretUsed: true,
      graceSecretAgeHours: 12,
      reason: 'sweep_cycle_routine',
      actorType: 'admin',
      actorUserId: 'user-uuid',
      dispatchedByActorUserId: 'admin-uuid',
      dispatchedByActorRole: 'admin',
      sourceIp: '192.0.2.1',
      attemptedRoute: '/api/admin/events/foo',
      probedTenantId: 'swecham',
      signedTenantId: 'swecham',
      signatureLastFour: 'abcd',
      timestampSkewSeconds: 7,
      bodyLengthBytes: 1024,
    };
    const out = redactPayloadForFatalLog(payload);
    for (const key of Object.keys(payload)) {
      expect(out).toHaveProperty(key);
      expect(out[key]).toBe((payload as Record<string, unknown>)[key]);
    }
  });

  it('drops nested objects regardless of allowlist membership', () => {
    const payload = {
      severity: 'error',
      // `registrationId` is allowlisted but only as a primitive — a
      // nested-object value must still be dropped (PII safety).
      registrationId: { nested: 'leak@example.com' },
      // Same for any other allowed key.
      payload: { email: 'leak@example.com' },
    };
    const out = redactPayloadForFatalLog(payload);
    expect(out['severity']).toBe('error');
    expect(out['registrationId']).toBeUndefined();
    expect(out['payload']).toBeUndefined();
  });

  it('returns shape sentinel for non-object payload', () => {
    expect(redactPayloadForFatalLog(null)).toEqual({ _shape: 'non-object' });
    expect(redactPayloadForFatalLog('string-payload')).toEqual({ _shape: 'non-object' });
    expect(redactPayloadForFatalLog(42)).toEqual({ _shape: 'non-object' });
    expect(redactPayloadForFatalLog(undefined)).toEqual({ _shape: 'non-object' });
  });

  it('allowlist contains all forensic-context categories per JSDoc taxonomy', () => {
    // Snapshot-style assertion pinning the allowlist taxonomy. A future
    // refactor that removes a forensic field from the allowlist forces
    // a test update + reviewer scrutiny (the "snapshot drift catches the
    // regression" pattern). Updated in Round 3 R3.1.2 to include the
    // 18 forensic primitives missed by Round-2 R2-C1 (probedId,
    // probeSurface, probedAt for csv_import_cross_tenant_probe;
    // actorRole, attemptedAction, blockedAt for role_violation_blocked;
    // CSV import counters for csv_import_completed; override forensics;
    // attendeeEmailHash for csv_import_row_cancelled_no_prior).
    const expectedKeys = [
      // Forensic context
      'severity', 'requestId', 'source', 'scope',
      // Probe/attack signals
      'sourceIp', 'attemptedRoute', 'probedTenantId', 'signedTenantId',
      'probedId', 'probeSurface', 'probedAt',
      // Signature failure details
      'signatureLastFour', 'timestampSkewSeconds', 'bodyLengthBytes',
      // Operation outcomes
      'errorName', 'failureStage', 'stage', 'rowNumber', 'rowsCleared', 'durationMs',
      // CSV import row counters (forensic primitives)
      'rowsProcessed', 'rowsAlreadyImported', 'rowsStateChanged',
      'eventsCreated', 'eventsUpdated', 'errorRowCount', 'timedOut', 'sourceFormat',
      // CSV import override forensics
      'recordId', 'currentEventId', 'overriddenAt',
      // R7.S / Staff R2 R042 — PII erasure latency primitive
      'completedWithinSecondsOfRequest',
      // Identifiers (non-PII)
      'registrationId', 'eventId', 'matchType',
      // Actor classification (non-PII)
      'actorType', 'actorUserId', 'dispatchedByActorUserId', 'dispatchedByActorRole',
      'actorRole', 'attemptedAction', 'blockedAt',
      // Cancellation forensics (already-hashed PII)
      'attendeeEmailHash',
      // State signals
      'graceSecretUsed', 'graceSecretAgeHours', 'reason',
    ];
    expect([...REDACT_ALLOWED_KEYS].sort()).toEqual(expectedKeys.sort());
  });

  it('round-trip: csv_import_cross_tenant_probe (Constitution P-I cl.4 critical) preserves all forensic primitives', () => {
    // Real payload from src/app/api/admin/events/import/route.ts:573-580.
    // SRE MUST see probedId + probeSurface + sourceIp during a DB-down
    // incident — otherwise the security event is forensic-blind.
    const payload = {
      severity: 'critical',
      actorUserId: 'admin-uuid',
      probedId: 'event-uuid-from-another-tenant',
      probeSurface: 'import_event_id',
      sourceIp: '203.0.113.1',
      probedAt: '2026-05-17T10:00:00.000Z',
    };
    const out = redactPayloadForFatalLog(payload);
    for (const key of Object.keys(payload)) {
      expect(out).toHaveProperty(key);
      expect(out[key]).toBe((payload as Record<string, unknown>)[key]);
    }
  });

  it('round-trip: role_violation_blocked preserves actor + action + blockedAt', () => {
    // Real payload from src/app/api/admin/events/_lib/role-violation-audit.ts:89-96
    // + the /admin/integrations/eventcreate/_lib sibling. SRE forensics
    // need actorRole (member vs manager) + attemptedAction (which mutation)
    // + blockedAt (app_layer vs db_layer in future variants).
    const payload = {
      severity: 'warn',
      actorUserId: 'manager-uuid',
      actorRole: 'manager',
      attemptedRoute: '/api/admin/events/foo/archive',
      attemptedAction: 'archive_event',
      blockedAt: 'app_layer',
    };
    const out = redactPayloadForFatalLog(payload);
    for (const key of Object.keys(payload)) {
      expect(out).toHaveProperty(key);
      expect(out[key]).toBe((payload as Record<string, unknown>)[key]);
    }
  });

  it('round-trip: csv_import_completed preserves all row counters + flags', () => {
    // Real payload shape from audit-port.ts:455-485 (csv_import_completed
    // payload contract). matchCounts (nested object) MUST be dropped;
    // every other primitive preserved.
    const payload = {
      severity: 'info',
      actorUserId: 'admin-uuid',
      rowsProcessed: 150,
      rowsAlreadyImported: 25,
      rowsStateChanged: 5,
      eventsCreated: 2,
      eventsUpdated: 1,
      errorRowCount: 3,
      durationMs: 12500,
      timedOut: false,
      sourceFormat: 'eventcreate_csv',
      // Nested object MUST be dropped (PII-safety: matchCounts is
      // intentionally not allowlisted as a top-level key).
      matchCounts: { member_contact: 100, non_member: 50 },
    };
    const out = redactPayloadForFatalLog(payload);
    expect(out['rowsProcessed']).toBe(150);
    expect(out['rowsAlreadyImported']).toBe(25);
    expect(out['rowsStateChanged']).toBe(5);
    expect(out['eventsCreated']).toBe(2);
    expect(out['eventsUpdated']).toBe(1);
    expect(out['errorRowCount']).toBe(3);
    expect(out['durationMs']).toBe(12500);
    expect(out['timedOut']).toBe(false);
    expect(out['sourceFormat']).toBe('eventcreate_csv');
    // Nested object dropped:
    expect(out['matchCounts']).toBeUndefined();
  });

  it('round-trip: csv_import_event_mismatch_overridden preserves override forensics', () => {
    // Real payload from import-csv.ts:1912-1927 — admin overriding the
    // FR-019b safety net. priorRecordIds / priorEventIds are arrays →
    // dropped; per-row primitives (recordId, currentEventId, overriddenAt)
    // preserved.
    const payload = {
      severity: 'warn',
      actorUserId: 'admin-uuid',
      recordId: '11111111-2222-4333-8444-555555555555',
      currentEventId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      overriddenAt: '2026-05-17T10:30:00.000Z',
      // Arrays dropped:
      priorRecordIds: ['old-record-1', 'old-record-2'],
      priorEventIds: ['old-event-1'],
    };
    const out = redactPayloadForFatalLog(payload);
    expect(out['recordId']).toBe(payload.recordId);
    expect(out['currentEventId']).toBe(payload.currentEventId);
    expect(out['overriddenAt']).toBe(payload.overriddenAt);
    // Arrays dropped:
    expect(out['priorRecordIds']).toBeUndefined();
    expect(out['priorEventIds']).toBeUndefined();
  });

  it('round-trip: csv_import_row_cancelled_no_prior preserves hashed PII', () => {
    // Real payload from import-csv.ts:1152-1167 — first-time Cancellation
    // row skipped. attendeeEmailHash is SHA-256 hex prefix, NOT raw PII,
    // so it's safe to log.
    const payload = {
      severity: 'info',
      rowNumber: 42,
      attendeeEmailHash: 'a1b2c3d4e5f60718', // SHA-256 first-16-hex
    };
    const out = redactPayloadForFatalLog(payload);
    expect(out['rowNumber']).toBe(42);
    expect(out['attendeeEmailHash']).toBe('a1b2c3d4e5f60718');
  });

  it('R6.S / R026 — allowlist-deny-by-default: arbitrary unknown fields are dropped', () => {
    // Guards against a future refactor flipping the redactor from
    // allowlist-deny-by-default to denylist-allow-by-default. The
    // LOAD-BEARING assertion is `Object.keys(out).length === 0` —
    // it proves NO unknown field survived (not just the 4 specific
    // probes). The 4 probes include a PII-shape probe so a denylist
    // regression would surface even on PII-looking-but-unknown fields.
    const out = redactPayloadForFatalLog({
      unknownFieldNeverInAllowlist: 'this should be dropped',
      anotherFakeField: 42,
      maliciousLookalike: 'severity-like-string-but-wrong-key',
      // R7.S / R040 — PII-shape probe ensures a denylist regression
      // would surface even when the unknown field name looks like
      // intentional user data (not just dummy).
      userEmail: 'leak@example.com',
    });
    expect(out).not.toHaveProperty('unknownFieldNeverInAllowlist');
    expect(out).not.toHaveProperty('anotherFakeField');
    expect(out).not.toHaveProperty('maliciousLookalike');
    expect(out).not.toHaveProperty('userEmail');
    // Load-bearing assertion — empty allowlist intersection ⇒ empty
    // projection (no `_shape` sentinel; that's reserved for non-object
    // inputs).
    expect(Object.keys(out)).toHaveLength(0);
  });

  it('PII field names that overlap with allowlist semantics are NOT auto-allowed', () => {
    // Defence-in-depth: even if a future payload misuses an allowlisted
    // field name (e.g., `requestId` carrying an email), the value must
    // be a primitive — strings pass through, but nested PII gets stripped.
    const out = redactPayloadForFatalLog({
      requestId: 'leak@example.com',
    });
    // Primitive string passes the allowlist — this is INTENTIONAL.
    // The allowlist trusts that field-name semantics align with type.
    // A future audit-port change adding a field with PII intent must
    // be reviewed against the JSDoc taxonomy comment.
    expect(out['requestId']).toBe('leak@example.com');
    // Test serves as documentation that allowlist fields trust their
    // semantic meaning — adding new fields requires explicit review.
  });
});
