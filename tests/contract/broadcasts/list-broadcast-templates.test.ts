/**
 * Phase 5 Round 1 R2.1 M-test-1 — `listBroadcastTemplates` contract.
 *
 * Covers FR-018 (MRU ordering proxy via updated_at DESC) +
 * cascading-locale filter (currentUserLocale → tenantDefaultLocale →
 * 'en') + includeAllLocales bypass.
 *
 * The repo is mocked; we only verify the use-case threads the right
 * locale (or omits the option for includeAllLocales) into
 * findByTenantId. Ordering is asserted by passing pre-sorted rows
 * through the mock — the use-case must NOT re-sort.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  listBroadcastTemplates,
  type BroadcastTemplate,
} from '@/modules/broadcasts';
import type {
  BroadcastTemplatesPort,
  ListTemplatesOpts,
} from '@/modules/broadcasts/application/ports/broadcast-templates-port';
import type { TenantSlug } from '@/modules/tenants';

const TENANT = 'tenant-swe' as unknown as TenantSlug;

function makeTemplate(
  overrides: Partial<BroadcastTemplate> = {},
): BroadcastTemplate {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    tenantId: TENANT,
    name: 'Default',
    subject: 'Subject',
    bodyHtml: '<p>x</p>',
    locale: 'en',
    startedFromCount: 0,
    isSeeded: false,
    createdByUserId: 'u-1',
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  };
}

function makePort(rows: readonly BroadcastTemplate[]): BroadcastTemplatesPort {
  return {
    findById: vi.fn(),
    findByIdInTx: vi.fn(),
    findByTenantId: vi.fn().mockResolvedValue(rows),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    incrementStartedFromCount: vi.fn(),
    withTx: vi.fn(),
  } as unknown as BroadcastTemplatesPort;
}

describe('listBroadcastTemplates — M-test-1', () => {
  it('preserves repo ordering (MRU proxy via updated_at DESC)', async () => {
    const t1 = makeTemplate({ id: 'a', updatedAt: new Date('2026-05-10') });
    const t2 = makeTemplate({ id: 'b', updatedAt: new Date('2026-05-05') });
    const t3 = makeTemplate({ id: 'c', updatedAt: new Date('2026-05-01') });
    const port = makePort([t1, t2, t3]);
    const result = await listBroadcastTemplates(
      { port },
      { tenantId: TENANT },
    );
    expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('cascading locale: currentUserLocale wins when provided', async () => {
    const port = makePort([]);
    await listBroadcastTemplates(
      { port },
      {
        tenantId: TENANT,
        currentUserLocale: 'th',
        tenantDefaultLocale: 'sv',
      },
    );
    expect(port.findByTenantId).toHaveBeenCalledWith(TENANT, {
      locale: 'th',
    } satisfies ListTemplatesOpts);
  });

  it('cascading locale: falls through to tenantDefaultLocale when user locale absent', async () => {
    const port = makePort([]);
    await listBroadcastTemplates(
      { port },
      { tenantId: TENANT, tenantDefaultLocale: 'sv' },
    );
    expect(port.findByTenantId).toHaveBeenCalledWith(TENANT, {
      locale: 'sv',
    });
  });

  it('cascading locale: falls through to "en" when neither provided', async () => {
    const port = makePort([]);
    await listBroadcastTemplates({ port }, { tenantId: TENANT });
    expect(port.findByTenantId).toHaveBeenCalledWith(TENANT, {
      locale: 'en',
    });
  });

  it('includeAllLocales bypasses the cascade (no opts passed)', async () => {
    const port = makePort([]);
    await listBroadcastTemplates(
      { port },
      {
        tenantId: TENANT,
        currentUserLocale: 'th',
        tenantDefaultLocale: 'sv',
        includeAllLocales: true,
      },
    );
    expect(port.findByTenantId).toHaveBeenCalledWith(TENANT);
  });
});
