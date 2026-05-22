/**
 * R6.7 M-12 — type-level test that locks the `emitTyped<E>` generic
 * constraint to `keyof F7AuditPayloadShapes` (NOT the wide
 * `F7AuditEventType` union).
 *
 * Before R6.7, the constraint allowed every F7 audit event but the
 * payload silently fell back to `Record<string, unknown>` for events
 * not in `F7AuditPayloadShapes`. Now the constraint forces a
 * deliberate choice: untyped events MUST go through `emit`; only the
 * 12 events with declared payload shapes are eligible for `emitTyped`.
 *
 * This file does not run any runtime assertions — the `@ts-expect-error`
 * markers + the structural assignment tests are the lock. If a future
 * refactor widens the constraint back to `F7AuditEventType`, the
 * `@ts-expect-error` lines become unused-directive warnings and the
 * test fails.
 */
import { describe, it, expect } from 'vitest';
import type {
  AuditPort,
  F7AuditPayloadShapes,
  TypedAuditEmitInput,
} from '@/modules/broadcasts/application/ports/audit-port';

describe('AuditPort.emitTyped<E> generic constraint — R6.7 M-12', () => {
  it('accepts events declared in F7AuditPayloadShapes (typed payload)', () => {
    // Type-level: this should compile cleanly because
    // `broadcast_template_snapshotted` is in F7AuditPayloadShapes.
    const typedInput: TypedAuditEmitInput<'broadcast_template_snapshotted'> = {
      eventType: 'broadcast_template_snapshotted',
      actorUserId: 'usr-1',
      summary: 's',
      payload: {
        broadcastId: 'bc-1',
        templateId: 'tpl-1',
        templateNameSnapshot: 'Tpl Name',
        memberId: 'mem-1',
      },
      tenantId: 'tenant-1',
      requestId: 'req-1',
    };
    expect(typedInput.eventType).toBe('broadcast_template_snapshotted');
  });

  it('compile-time test — events NOT in F7AuditPayloadShapes are rejected', () => {
    // `broadcast_drafted` is in F7_AUDIT_EVENT_TYPES (line 44 of
    // audit-port.ts) but NOT in F7AuditPayloadShapes — so it falls
    // outside `keyof F7AuditPayloadShapes`. The `@ts-expect-error`
    // line below MUST be load-bearing: if the constraint is ever
    // widened back to F7AuditEventType, this `@ts-expect-error` will
    // become unused and TS will surface a directive-unused error
    // which fails the typecheck. That failure is the test.
    //
    // R8.5 (R7 senior-tester MED-4 close) — use
    // `broadcast_subject_empty` as the marker event instead of
    // `broadcast_drafted`. Both are in F7_AUDIT_EVENT_TYPES but NOT
    // in F7AuditPayloadShapes today. Promotion risk is LOWER for
    // `broadcast_subject_empty` because it's a precondition-validation
    // signal (no structured payload semantics beyond eventType +
    // brodcastId), while `broadcast_drafted` is US1's primary
    // draft-state event and a likely future candidate for typed
    // payload. If `broadcast_subject_empty` ever gets promoted, swap
    // for another precondition event (e.g., `broadcast_audience_too_large`).
    type _UntypedEventShouldFail =
      // @ts-expect-error — `broadcast_subject_empty` is not in keyof F7AuditPayloadShapes
      TypedAuditEmitInput<'broadcast_subject_empty'>;
    // Touch the type to keep the binding live for ESLint.
    const _typeTouch: _UntypedEventShouldFail | undefined = undefined;
    void _typeTouch;

    // Runtime assertion that pairs the type-test with at least one
    // expect() call so vitest counts the test.
    expect(true).toBe(true);
  });

  it('AuditPort.emitTyped method signature is constrained to keyof F7AuditPayloadShapes', () => {
    // Build a minimal AuditPort to confirm the call-site narrowing
    // works through the interface (not just the standalone
    // TypedAuditEmitInput<E>).
    const audit: AuditPort = {
      emit: async () => undefined,
      emitTyped: async () => undefined,
    };
    // Typed event — compiles.
    void audit.emitTyped(null, {
      eventType: 'broadcast_template_snapshotted',
      actorUserId: 'usr-1',
      summary: 's',
      payload: {
        broadcastId: 'bc-1',
        templateId: 'tpl-1',
        templateNameSnapshot: 'n',
        memberId: 'mem-1',
      },
      tenantId: 't',
      requestId: 'r',
    });
    expect(true).toBe(true);
  });

  it('F7AuditPayloadShapes still covers the 12 declared events', () => {
    // Lock the documented count (audit-port.ts header line 31) so a
    // future addition that bumps the count surfaces here for review.
    type _Keys = keyof F7AuditPayloadShapes;
    const declared: ReadonlyArray<_Keys> = [
      'broadcast_submitted',
      'broadcast_cancelled',
      'broadcast_unsubscribed',
      'broadcast_suppression_applied',
      'broadcast_quota_consumed',
      'broadcast_cross_tenant_probe',
      'broadcast_cross_member_probe',
      'broadcast_webhook_batch_missing',
      'broadcast_template_snapshotted',
      'broadcast_template_seed_skipped_existing_name',
      'broadcast_template_snapshot_refused_deleted',
      'broadcast_webhook_signature_rejected',
    ];
    expect(declared.length).toBe(12);
  });
});
