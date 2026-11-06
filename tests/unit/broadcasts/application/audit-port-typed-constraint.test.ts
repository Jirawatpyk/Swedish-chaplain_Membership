/**
 * R6.7 M-12 — type-level test that locks the `emitTyped<E>` generic
 * constraint to `keyof F7AuditPayloadShapes` (NOT the wide
 * `F7AuditEventType` union).
 *
 * Before R6.7, the constraint allowed every F7 audit event but the
 * payload silently fell back to `Record<string, unknown>` for events
 * not in `F7AuditPayloadShapes`. Now the constraint forces a
 * deliberate choice: untyped events MUST go through `emit`; only the
 * events with declared payload shapes (30 since spec 139 s2's two audience rows) are eligible for `emitTyped`.
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

  it('emit, emitTyped, emitMany and emitManyTyped do not compile with broadcast_audience_deleted (spec 142 r2)', () => {
    // Spec 142 review round 2 (code-review #2) — the deleted row's only writer
    // is `AudienceDeletedAuditPort.emitOnce`; the shared port's methods exclude
    // the event by type (the adapter's runtime refusal stays behind it). Each
    // `@ts-expect-error` is load-bearing: widen a signature back and the
    // directive becomes unused, which fails `tsc`. The disclosed row is the
    // positive control: the same calls compile.
    const audit: AuditPort = {
      emit: async () => undefined,
      emitTyped: async () => undefined,
      emitMany: async () => undefined,
      emitManyTyped: async () => undefined,
    };
    const common = {
      broadcast_id: 'bc-1',
      related_member_id: 'mem-1',
      resend_audience_id: 'aud-1',
      leg: 'import',
      actor_role: 'system',
    } as const;
    const fields = { actorUserId: 'system:cron', summary: 's', tenantId: 't', requestId: null };
    const deleted = { ...fields, eventType: 'broadcast_audience_deleted' as const, payload: { ...common, reason: 'terminal_cleanup' as const } };
    const disclosed = { ...fields, eventType: 'broadcast_audience_disclosed' as const, payload: { ...common, recipient_count: 2 } };

    // @ts-expect-error — `emit` takes F7EmitEventType, which excludes broadcast_audience_deleted
    void audit.emit(null, deleted);
    // @ts-expect-error — `emitTyped`'s E excludes broadcast_audience_deleted
    void audit.emitTyped(null, deleted);
    // @ts-expect-error — `emitMany` takes AuditEmitInput, whose event type excludes it
    void audit.emitMany?.(null, [deleted]);
    // @ts-expect-error — `emitManyTyped`'s E excludes broadcast_audience_deleted
    void audit.emitManyTyped?.(null, [deleted]);

    void audit.emit(null, disclosed);
    void audit.emitTyped(null, disclosed);
    void audit.emitMany?.(null, [disclosed]);
    void audit.emitManyTyped?.(null, [disclosed]);
    expect(true).toBe(true);
  });

  it('F7AuditPayloadShapes covers exactly the 30 declared events', () => {
    // Lock the documented count so a future addition surfaces here for
    // review. The list used to be typed `ReadonlyArray<keyof …>`, which a
    // SUBSET satisfies — it read 12 while the map held 13. `_allDeclared`
    // below now fails `tsc` when a key is missing from this list.
    type _Keys = keyof F7AuditPayloadShapes;
    const declared = [
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
      'broadcast_content_redacted',
      'broadcast_test_copy_sent',
      'broadcast_brand_settings_changed',
      'broadcast_image_uploaded',
      'broadcast_image_removed',
      // F119 PR-2 (T056 / T057)
      'broadcast_version_started',
      'broadcast_member_approval_voided',
      // F119 PR-2 (T059 / T060)
      'broadcast_version_sent_to_member',
      'broadcast_schedule_confirmed',
      // F119 PR-2 (T078)
      'broadcast_member_approved',
      'broadcast_member_changes_requested',
      'broadcast_member_approval_withdrawn',
      // F119 PR-2 (T130) — the daily approval-lifecycle tick (system rows)
      'broadcast_approval_reminder_sent',
      'broadcast_approval_expiry_warned',
      'broadcast_approval_expired',
      // F7 retention sweep (migration 0310) — the counts-only run row
      'broadcast_retention_swept',
      // Spec 139 s2 (migration 0327) — the import tick's disclosure row
      'broadcast_audience_disclosed',
      // Spec 139 s2 (migration 0327) — the segment delete row
      'broadcast_audience_deleted',
    ] as const satisfies ReadonlyArray<_Keys>;
    const _allDeclared: [Exclude<_Keys, (typeof declared)[number]>] extends [never] ? true : never = true;
    void _allDeclared;
    expect(declared.length).toBe(30);
  });
});
