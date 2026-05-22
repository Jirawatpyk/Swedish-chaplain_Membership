/**
 * T089 (F7.1a US7) — Contract test for `snapshotTemplateToDraft` use-case
 * (SC-007a — 500ms snapshot target verified separately in Phase 5J bench).
 *
 * Verifies member snapshot flow per contracts § 1.4:
 *   - Loads template (RLS-scoped) → applies substituteChamberName →
 *     UPDATEs draft subject + body + started_from_template_id +
 *     template_name_snapshot in same tx
 *   - template.started_from_count++ atomic
 *   - Cross-tenant probe (templateId belongs to tenant B) →
 *     template_not_found + broadcast_cross_tenant_probe audit
 *   - Soft-deleted template → template_not_found
 *
 * RED-first per Constitution Principle II. GREEN at Phase 5D T102.
 */
import { describe, expect, it, vi } from 'vitest';
import { snapshotTemplateToDraft } from '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft';
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { TenantDisplayNamePort } from '@/modules/broadcasts/application/ports/tenant-display-name-port';
import {
  BroadcastNotFoundError,
  type BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant-swe' as never;
const ACTOR_MEMBER = 'user_mem_42';
const DRAFT_ID = '44444444-4444-4444-4444-444444444444';
const TEMPLATE_ID = '55555555-5555-5555-5555-555555555555';

const NOW = new Date('2026-05-20T03:00:00Z');

const makeTemplate = (overrides?: Partial<BroadcastTemplate>): BroadcastTemplate => ({
  id: TEMPLATE_ID,
  tenantId: TENANT,
  name: 'Monthly Newsletter',
  subject: '{{chamber_name}} Newsletter — [Month YYYY]',
  bodyHtml:
    '<h2>{{chamber_name}} Newsletter</h2><p>Hello [member name],</p><p>This month at {{chamber_name}}...</p>',
  locale: 'en',
  startedFromCount: 0,
  isSeeded: true,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
  ...overrides,
});

const makeDeps = (overrides?: {
  template?: BroadcastTemplate | null;
  chamberName?: string;
  ownership?:
    | { readonly probeKind: 'owned'; readonly broadcast: unknown }
    | { readonly probeKind: 'not_found'; readonly broadcast: null }
    | { readonly probeKind: 'cross_member'; readonly broadcast: null };
}): {
  templatesPort: BroadcastTemplatesPort;
  broadcastsRepo: BroadcastsRepo;
  tenantDisplayName: TenantDisplayNamePort;
  audit: AuditPort;
} => {
  // Explicit undefined-check — `??` would treat null as "use default"
  // and mask the cross-tenant-probe scenario.
  const tpl =
    overrides && 'template' in overrides
      ? overrides.template
      : makeTemplate();
  const ownership = overrides?.ownership ?? {
    probeKind: 'owned' as const,
    broadcast: { broadcastId: DRAFT_ID, requestedByMemberId: 'mem-1' },
  };
  return {
    templatesPort: {
      findById: vi.fn().mockResolvedValue(tpl),
      // R3-F11 + R4.3 M-10: snapshot use-case calls
      // findByIdAllowDeletedInTx (TOCTOU-safe AND distinguishes
      // soft-deleted from never-existed). Mock default returns the
      // same template (deletedAt null per makeTemplate default).
      findByIdAllowDeletedInTx: vi.fn().mockResolvedValue(tpl),
      findByTenantId: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      incrementStartedFromCount: vi.fn().mockResolvedValue(undefined),
      withTx: vi.fn(
        async <T>(_t: never, fn: (tx: unknown) => Promise<T>) => fn(null),
      ),
    } as BroadcastTemplatesPort,
    broadcastsRepo: {
      // Minimal mock — snapshot use-case needs findOwnedByMember (R1.1
      // CRIT-1 draft-ownership check) + updateDraftFromTemplate.
      findOwnedByMember: vi.fn().mockResolvedValue(ownership),
      updateDraftFromTemplate: vi.fn().mockResolvedValue(undefined),
    } as unknown as BroadcastsRepo,
    tenantDisplayName: {
      resolve: vi
        .fn()
        .mockResolvedValue(overrides?.chamberName ?? 'SweCham'),
    },
    audit: { emit: vi.fn().mockResolvedValue(undefined), emitTyped: vi.fn().mockResolvedValue(undefined) },
  };
};

describe('snapshotTemplateToDraft contract — T089 (F7.1a US7)', () => {
  it('member picks template → draft updated with substituted chamber_name + template_name_snapshot', async () => {
const deps = makeDeps({ chamberName: 'SweCham' });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-030',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      // chamber_name substituted in subject
      expect(r.value.subject).toBe('SweCham Newsletter — [Month YYYY]');
      // chamber_name substituted in body (both occurrences) + bracket
      // placeholders preserved literal
      expect(r.value.bodyHtml).toContain('SweCham Newsletter');
      expect(r.value.bodyHtml).toContain('This month at SweCham');
      expect(r.value.bodyHtml).toContain('[member name]');
      expect(r.value.templateNameSnapshot).toBe('Monthly Newsletter');
    }
    // template.started_from_count incremented atomically
    expect(deps.templatesPort.incrementStartedFromCount).toHaveBeenCalledWith(
      TENANT,
      TEMPLATE_ID,
      null,
    );
  });

  it('cross-tenant probe (template belongs to tenant B) → template_not_found + cross-tenant audit with template payload', async () => {
const deps = makeDeps({ template: null });
    // R3-F11: snapshot use-case now reads via findByIdAllowDeletedInTx.
    // Return null → cross-tenant probe (vs returning a row with
    // deletedAt populated which would be template_soft_deleted).
    (
      deps.templatesPort as unknown as {
        findByIdAllowDeletedInTx: ReturnType<typeof vi.fn>;
      }
    ).findByIdAllowDeletedInTx.mockResolvedValueOnce(null);
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-031',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_not_found');
    // R1.1 H-code-4: payload now uses probedTemplateId + resourceKind
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_cross_tenant_probe',
        payload: expect.objectContaining({
          probedTenantId: TENANT,
          probedTemplateId: TEMPLATE_ID,
          resourceKind: 'template',
        }),
      }),
    );
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
  });

  it('R3-F11: template soft-deleted between picker render + snapshot click → template_soft_deleted (distinct from not_found)', async () => {
    // Same template the picker showed at T1, now soft-deleted at T2
    // (admin deleted it while member was composing). Mock returns the
    // row with `deletedAt` populated.
    const tpl = makeTemplate();
    const softDeletedTpl: typeof tpl = {
      ...tpl,
      deletedAt: new Date('2026-05-20T12:00:00Z'),
    };
    const deps = makeDeps();
    (
      deps.templatesPort as unknown as {
        findByIdAllowDeletedInTx: ReturnType<typeof vi.fn>;
      }
    ).findByIdAllowDeletedInTx.mockResolvedValueOnce(softDeletedTpl);
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-soft-deleted',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_soft_deleted');
    // R6.4 M-1 — refused-deleted is a TERMINAL READ-ONLY outcome with
    // no mutations to co-commit. R6.4 swapped the R3.2 H-2 in-tx
    // `audit.emitTyped(tx, ...)` for `safeAuditEmit(null, ...)` so
    // audit storage hiccups can't roll the empty tx → convert HTTP
    // 410 → 500.
    //
    // R8.1 M-1 — upgraded to `safeAuditEmitTyped(null, ...)` which
    // routes through `audit.emitTyped` (NOT `audit.emit`). Restores
    // typed-payload narrowing symmetry with the success branch.
    expect(deps.audit.emitTyped).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_template_snapshot_refused_deleted',
        payload: expect.objectContaining({
          templateId: tpl.id,
          templateNameSnapshot: tpl.name,
        }),
      }),
    );
    // R3.4 M-2 compound assertion — no mutation side-effects fire.
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    expect(
      (deps.broadcastsRepo as unknown as { updateDraftFromTemplate: ReturnType<typeof vi.fn> })
        .updateDraftFromTemplate,
    ).not.toHaveBeenCalled();
    // Only the refusal audit fires — no other audit events.
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(1);
    expect(deps.audit.emit).not.toHaveBeenCalled();
  });

  it('R6.4 M-1: refused-deleted + audit storage failure → still returns template_soft_deleted (NOT 500) + metric counter increments', async () => {
    // Audit-storage failure on the refused-deleted path MUST be
    // swallowed by safeAuditEmitTyped — the use-case still returns the
    // soft-deleted error (HTTP 410) without 5xx. Forensic record is
    // lost (best-effort) but the user-visible status is preserved.
    // R8.1 M-1 — assertion now rejects `emitTyped` (post-typed-helper
    // migration).
    //
    // R010 Round 2 closure 2026-05-21 (senior-tester staff-review):
    // also pin `broadcastsMetrics.auditEmitFailed` counter increment.
    // The metric is the SIEM-alarm source per docs/observability.md
    // § 22.2 — a regression dropping the counter call inside
    // `safeAuditEmitTyped` (`_safe-audit-emit.ts:146`) would silently
    // kill the alert pipeline for this event type. The
    // `safe-audit-emit.test.ts` R008 block pins the helper in unit-
    // isolation; this assertion pins it through the use-case caller
    // surface so a refactor that bypasses the helper (e.g., re-inlines
    // the try/catch with no counter call) also fails.
    const { broadcastsMetrics } = await import('@/lib/metrics');
    const metricSpy = vi
      .spyOn(broadcastsMetrics, 'auditEmitFailed')
      .mockImplementation(() => undefined);

    try {
      const SOFT_DELETED_AT = new Date('2026-05-19T10:00:00Z');
      const tpl = makeTemplate({ id: TEMPLATE_ID, deletedAt: SOFT_DELETED_AT });
      const deps = makeDeps({ template: tpl });
      (deps.audit.emitTyped as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('audit storage down'),
      );
      const r = await snapshotTemplateToDraft(deps, {
        tenantId: TENANT,
        actorUserId: ACTOR_MEMBER,
        memberId: 'mem-1',
        draftId: DRAFT_ID,
        templateId: TEMPLATE_ID,
        requestId: 'req-r6.4-m1-audit-fail',
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('template_soft_deleted');
      // No mutations attempted.
      expect(
        (deps.broadcastsRepo as unknown as { updateDraftFromTemplate: ReturnType<typeof vi.fn> })
          .updateDraftFromTemplate,
      ).not.toHaveBeenCalled();
      expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
      // R010 metric assertion: counter incremented with event type + tenant id.
      expect(metricSpy).toHaveBeenCalledWith(
        'broadcast_template_snapshot_refused_deleted',
        TENANT,
      );
    } finally {
      metricSpy.mockRestore();
    }
  });

  it('CRIT-1: cross-member draft hijack → broadcast_cross_member_probe audit + draft_not_found + counter NOT incremented', async () => {
    const deps = makeDeps({
      ownership: { probeKind: 'cross_member', broadcast: null },
    });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-attacker',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-crit1',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('draft_not_found');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_cross_member_probe',
        payload: expect.objectContaining({
          probedMemberId: 'mem-attacker',
          probedBroadcastId: DRAFT_ID,
        }),
      }),
    );
    // Counter MUST NOT bump on hostile probe
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    // Body MUST NOT be touched
    expect(deps.broadcastsRepo.updateDraftFromTemplate).not.toHaveBeenCalled();
  });

  it('CRIT-1: draft genuinely not found → draft_not_found WITHOUT cross-member audit (benign cache miss)', async () => {
    const deps = makeDeps({
      ownership: { probeKind: 'not_found', broadcast: null },
    });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-crit1b',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('draft_not_found');
    // No probe audit for benign not_found
    expect(deps.audit.emit).not.toHaveBeenCalledWith(
      null,
      expect.objectContaining({ eventType: 'broadcast_cross_member_probe' }),
    );
  });

  it('R1.2 H-sf-3: BroadcastConcurrentMutationError → draft_status_drift kind + broadcast_concurrent_action_blocked audit', async () => {
    const { BroadcastConcurrentMutationError } = await import(
      '@/modules/broadcasts/application/ports/broadcasts-repo'
    );
    const deps = makeDeps();
    (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate.mockRejectedValueOnce(
      new BroadcastConcurrentMutationError(
        'tenant-swe' as never,
        DRAFT_ID as never,
        'submitted',
      ),
    );
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-status-drift',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.kind).toBe('draft_status_drift');
      if (r.error.kind === 'draft_status_drift') {
        expect(r.error.currentStatus).toBe('submitted');
      }
    }
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({
        eventType: 'broadcast_concurrent_action_blocked',
        payload: expect.objectContaining({
          broadcastId: DRAFT_ID,
          observedStatus: 'submitted',
        }),
      }),
    );
    // Counter MUST NOT bump on status drift
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    // R4.1 C-3 — audit-last reorder: success audit MUST NOT fire
    // when the mutation throws. Pre-R4.1 emit order was audit-first
    // which left ghost `broadcast_template_snapshotted` rows when
    // the use-case caught + returned err() (Drizzle only rolls back
    // on thrown exceptions, not returned-Err).
    // R6.2 H1 — use-case calls `emitTyped` for the success path.
    expect(deps.audit.emitTyped).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'broadcast_template_snapshotted',
      }),
    );
    // R6.3 M-9 — anchor the call count so an arg-swap regression
    // (e.g., positional swap of tx + event) can't slip past the
    // `not.toHaveBeenCalledWith` assertion above.
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(0);
  });

  it('R4.1 C-3: BroadcastNotFoundError post-ownership-check → draft_not_found + NO ghost snapshot audit', async () => {
    // R6.3 L-9 — `BroadcastNotFoundError` hoisted to module-level import.
    const deps = makeDeps();
    (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate.mockRejectedValueOnce(
      new BroadcastNotFoundError('tenant-swe' as never, DRAFT_ID as never),
    );
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-not-found',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('draft_not_found');
    // Counter MUST NOT bump on post-ownership disappearance
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
    // R4.1 C-3 ghost-audit guard — success audit MUST NOT fire.
    // R6.2 H1 — assert via emitTyped (post-`??`-fallback drop).
    expect(deps.audit.emitTyped).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        eventType: 'broadcast_template_snapshotted',
      }),
    );
    // R6.3 M-9 — anchor the call count. BroadcastNotFoundError path
    // (post-ownership-check disappearance) emits ZERO audit events
    // (the use-case logs at error severity + returns draft_not_found).
    expect(deps.audit.emitTyped).toHaveBeenCalledTimes(0);
  });

  it('R1.2 H-sf-3: unexpected generic Error → propagates (NOT mapped to draft_not_found)', async () => {
    const deps = makeDeps();
    (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate.mockRejectedValueOnce(
      new Error('Postgres connection lost'),
    );
    await expect(
      snapshotTemplateToDraft(deps, {
        tenantId: TENANT,
        actorUserId: ACTOR_MEMBER,
        memberId: 'mem-1',
        draftId: DRAFT_ID,
        templateId: TEMPLATE_ID,
        requestId: 'req-unexpected',
      }),
    ).rejects.toThrow('Postgres connection lost');
  });

  it('CRIT-4: successful snapshot → audit emits broadcast_template_snapshotted inside withTx', async () => {
    const deps = makeDeps();
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-crit4',
    });
    expect(r.ok).toBe(true);
    // R6.3 L-7 — audit-LAST call-order anchor. The R4.1 C-3 audit-LAST
    // pattern requires `updateDraftFromTemplate` (mutation) BEFORE
    // `audit.emitTyped` (success record). vitest assigns monotonic
    // `invocationCallOrder` to every mock invocation across the test;
    // mutation order < audit order proves the success audit fires
    // AFTER mutations succeed, not before.
    //
    // R8.3 M-6 — use `Math.max(...invocationCallOrder)` instead of
    // `[0]`. If a future refactor adds retry-on-`BroadcastConcurrentMutationError`
    // semantics, `updateDraftFromTemplate` may be called twice; we
    // need the LAST successful mutation to precede the audit. Plus
    // anchor "no retry today" via `toHaveBeenCalledTimes(1)` so a
    // future contributor adding silent retry surfaces a test failure.
    const updateMock = (
      deps.broadcastsRepo as unknown as {
        updateDraftFromTemplate: ReturnType<typeof vi.fn>;
      }
    ).updateDraftFromTemplate;
    const emitTypedMock = deps.audit.emitTyped as ReturnType<typeof vi.fn>;
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(Math.max(...updateMock.mock.invocationCallOrder)).toBeLessThan(
      Math.min(...emitTypedMock.mock.invocationCallOrder),
    );
    // emit called with tx-token (mock withTx passes null as tx) +
    // template_snapshotted event + payload includes templateId,
    // memberId, broadcastId, templateNameSnapshot.
    // R6.2 H1 — use-case calls `audit.emitTyped(tx, ...)` directly.
    expect(deps.audit.emitTyped).toHaveBeenCalledWith(
      null, // tx (mock withTx)
      expect.objectContaining({
        eventType: 'broadcast_template_snapshotted',
        actorUserId: ACTOR_MEMBER,
        tenantId: TENANT,
        payload: expect.objectContaining({
          broadcastId: DRAFT_ID,
          templateId: TEMPLATE_ID,
          templateNameSnapshot: 'Monthly Newsletter',
          memberId: 'mem-1',
        }),
      }),
    );
  });

  it('soft-deleted template → template_not_found (deleted_at filter)', async () => {
// findById returns null because port filters deleted_at IS NULL
    const deps = makeDeps({ template: null });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-032',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_not_found');
  });

  it('tenant display_name with HTML metacharacters → escaped on substitution (XSS prevention)', async () => {
const deps = makeDeps({ chamberName: '<script>alert(1)</script>' });
    const r = await snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-033',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.subject).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(r.value.subject).not.toContain('<script>');
      expect(r.value.bodyHtml).not.toContain('<script>');
    }
  });
});
