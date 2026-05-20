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
import type {
  BroadcastTemplate,
  BroadcastTemplatesPort,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { TenantDisplayNamePort } from '@/modules/broadcasts/application/ports/tenant-display-name-port';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { AuditPort } from '@/modules/broadcasts/application/ports/audit-port';

const TENANT = 'tenant-swe' as never;
const ACTOR_MEMBER = 'user_mem_42';
const DRAFT_ID = '44444444-4444-4444-4444-444444444444';
const TEMPLATE_ID = '55555555-5555-5555-5555-555555555555';

const dynImport = new Function('m', 'return import(m)') as <T = unknown>(
  modulePath: string,
) => Promise<T>;

interface SnapshotTemplateModule {
  readonly snapshotTemplateToDraft: (
    deps: {
      readonly templatesPort: BroadcastTemplatesPort;
      readonly broadcastsRepo: BroadcastsRepo;
      readonly tenantDisplayName: TenantDisplayNamePort;
      readonly audit: AuditPort;
    },
    input: {
      readonly tenantId: typeof TENANT;
      readonly actorUserId: string;
      readonly memberId: string;
      readonly draftId: string;
      readonly templateId: string;
      readonly requestId: string;
    },
  ) => Promise<
    | {
        ok: true;
        value: {
          readonly draftId: string;
          readonly subject: string;
          readonly bodyHtml: string;
          readonly templateNameSnapshot: string;
        };
      }
    | { ok: false; error: { kind: string; [key: string]: unknown } }
  >;
}

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
}): {
  templatesPort: BroadcastTemplatesPort;
  broadcastsRepo: BroadcastsRepo;
  tenantDisplayName: TenantDisplayNamePort;
  audit: AuditPort;
} => {
  const tpl = overrides?.template ?? makeTemplate();
  return {
    templatesPort: {
      findById: vi.fn().mockResolvedValue(tpl),
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
      // Minimal mock — snapshot use-case only needs to UPDATE the draft
      // body+subject+started_from_template_id+template_name_snapshot.
      updateDraftFromTemplate: vi.fn().mockResolvedValue(undefined),
    } as unknown as BroadcastsRepo,
    tenantDisplayName: {
      resolve: vi
        .fn()
        .mockResolvedValue(overrides?.chamberName ?? 'SweCham'),
    },
    audit: { emit: vi.fn().mockResolvedValue(undefined) },
  };
};

describe('snapshotTemplateToDraft contract — T089 (F7.1a US7)', () => {
  it('member picks template → draft updated with substituted chamber_name + template_name_snapshot', async () => {
    const mod = await dynImport<SnapshotTemplateModule>(
      '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft',
    );
    const deps = makeDeps({ chamberName: 'SweCham' });
    const r = await mod.snapshotTemplateToDraft(deps, {
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
      expect.anything(),
    );
  });

  it('cross-tenant probe (template belongs to tenant B) → template_not_found + cross-tenant audit', async () => {
    const mod = await dynImport<SnapshotTemplateModule>(
      '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft',
    );
    const deps = makeDeps({ template: null });
    const r = await mod.snapshotTemplateToDraft(deps, {
      tenantId: TENANT,
      actorUserId: ACTOR_MEMBER,
      memberId: 'mem-1',
      draftId: DRAFT_ID,
      templateId: TEMPLATE_ID,
      requestId: 'req-031',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('template_not_found');
    expect(deps.audit.emit).toHaveBeenCalledWith(
      null,
      expect.objectContaining({ eventType: 'broadcast_cross_tenant_probe' }),
    );
    expect(deps.templatesPort.incrementStartedFromCount).not.toHaveBeenCalled();
  });

  it('soft-deleted template → template_not_found (deleted_at filter)', async () => {
    const mod = await dynImport<SnapshotTemplateModule>(
      '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft',
    );
    // findById returns null because port filters deleted_at IS NULL
    const deps = makeDeps({ template: null });
    const r = await mod.snapshotTemplateToDraft(deps, {
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
    const mod = await dynImport<SnapshotTemplateModule>(
      '@/modules/broadcasts/application/use-cases/snapshot-template-to-draft',
    );
    const deps = makeDeps({ chamberName: '<script>alert(1)</script>' });
    const r = await mod.snapshotTemplateToDraft(deps, {
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
