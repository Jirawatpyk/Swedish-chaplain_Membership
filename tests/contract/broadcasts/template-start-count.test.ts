/**
 * F119 T108 (FR-046, FR-046a, exploration § B) — starting from a template
 * through the SHIPPED path increments `startedFromCount` exactly once.
 *
 * `started_from_count` is the only adoption signal the template library has
 * (`admin/broadcasts/templates` renders it per row), and nothing on the
 * shipped path ever wrote to it: the `?template=` deep link pre-populates the
 * compose page server-side, and since `8a458e6a9` the picker re-seeds the form
 * IN PLACE on the client. The one counting path that exists —
 * `snapshotTemplateToDraft` behind
 * `POST /api/member/broadcasts/draft/[id]/snapshot-template` — needs a draft
 * that has already been saved, so the picker (which runs before any draft
 * exists) could never reach it. Every library row therefore read `0`.
 *
 * Three layers are pinned here, because "exactly once through the shipped
 * path" is a claim about all three:
 *
 *   1. the use case counts once per accepted start and NEVER on a refusal;
 *   2. the route maps the outcomes and calls the use case once per request;
 *   3. the picker the member actually uses issues exactly one count per
 *      template start — and none for the blank option, and none for a second
 *      pick of the SAME template.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { NextRequest } from 'next/server';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { err, ok } from '@/lib/result';

const TEMPLATE_ID = '55555555-5555-5555-5555-555555555555';
const OTHER_TEMPLATE_ID = '66666666-6666-6666-6666-666666666666';

// ---------------------------------------------------------------------------
// 1. Use case
// ---------------------------------------------------------------------------

function makeTemplate(overrides: Record<string, unknown> = {}) {
  return {
    id: TEMPLATE_ID,
    tenantId: 'test-tenant',
    name: 'Welcome',
    subject: 'Hello from {{chamber_name}}',
    bodyHtml: '<p>Hi</p>',
    locale: 'en',
    isSeeded: false,
    startedFromCount: 0,
    deletedAt: null,
    ...overrides,
  };
}

function makeDeps(template: unknown) {
  const incrementStartedFromCount = vi.fn().mockResolvedValue(undefined);
  const findByIdAllowDeletedInTx = vi.fn().mockResolvedValue(template);
  return {
    deps: {
      templatesPort: {
        withTx: async <T>(_t: unknown, fn: (tx: unknown) => Promise<T>) =>
          fn(null),
        findByIdAllowDeletedInTx,
        incrementStartedFromCount,
      },
      audit: { emit: vi.fn(), emitTyped: vi.fn() },
    },
    incrementStartedFromCount,
  };
}

const input = {
  tenantId: 'test-tenant',
  actorUserId: 'usr-1',
  templateId: TEMPLATE_ID,
  requestId: 'req-1',
} as const;

describe('F119 T108 — countTemplateStart use case', () => {
  it('increments the template counter exactly once', async () => {
    const { countTemplateStart } = await import(
      '@/modules/broadcasts/application/use-cases/count-template-start'
    );
    const { deps, incrementStartedFromCount } = makeDeps(makeTemplate());

    const result = await countTemplateStart(deps as never, input as never);

    expect(result.ok).toBe(true);
    expect(incrementStartedFromCount).toHaveBeenCalledTimes(1);
    expect(incrementStartedFromCount).toHaveBeenCalledWith(
      'test-tenant',
      TEMPLATE_ID,
      null,
    );
  });

  it('an unknown / other-tenant template is refused and NOT counted, and is audited as a cross-tenant probe', async () => {
    const { countTemplateStart } = await import(
      '@/modules/broadcasts/application/use-cases/count-template-start'
    );
    const { deps, incrementStartedFromCount } = makeDeps(null);

    const result = await countTemplateStart(deps as never, input as never);

    expect(result.ok).toBe(false);
    expect(incrementStartedFromCount).not.toHaveBeenCalled();
    expect(deps.audit.emit).toHaveBeenCalledTimes(1);
    const [, event] = deps.audit.emit.mock.calls[0] as unknown[];
    expect((event as { eventType: string }).eventType).toBe(
      'broadcast_cross_tenant_probe',
    );
  });

  it('a soft-deleted template is refused and NOT counted', async () => {
    const { countTemplateStart } = await import(
      '@/modules/broadcasts/application/use-cases/count-template-start'
    );
    const { deps, incrementStartedFromCount } = makeDeps(
      makeTemplate({ deletedAt: new Date('2026-09-01T00:00:00.000Z') }),
    );

    const result = await countTemplateStart(deps as never, input as never);

    expect(result.ok).toBe(false);
    expect(incrementStartedFromCount).not.toHaveBeenCalled();
  });

  it('a malformed template id is refused before any read', async () => {
    const { countTemplateStart } = await import(
      '@/modules/broadcasts/application/use-cases/count-template-start'
    );
    const { deps, incrementStartedFromCount } = makeDeps(makeTemplate());

    const result = await countTemplateStart(deps as never, {
      ...input,
      templateId: 'not-a-uuid',
    } as never);

    expect(result.ok).toBe(false);
    expect(deps.templatesPort.findByIdAllowDeletedInTx).not.toHaveBeenCalled();
    expect(incrementStartedFromCount).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Route
// ---------------------------------------------------------------------------

const getCurrentSessionMock = vi.fn();
const countTemplateStartMock = vi.fn();
const isF71aUs7EnabledMock = vi.fn();
const checkLimitMock = vi.fn();

vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: (...args: unknown[]) => getCurrentSessionMock(...args),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('@/modules/broadcasts', () => ({
  countTemplateStart: (...args: unknown[]) => countTemplateStartMock(...args),
  makeCountTemplateStartDeps: () => ({}),
  isF71aUs7Enabled: () => isF71aUs7EnabledMock(),
  f71aUs7DisabledReason: () => 'flag off',
  broadcastsRateLimiter: {
    checkLimit: (...args: unknown[]) => checkLimitMock(...args),
  },
}));

function makeRequest(): NextRequest {
  return new NextRequest(
    `http://localhost/api/broadcasts/templates/${TEMPLATE_ID}/started`,
    { method: 'POST' },
  );
}

function makeContext(id: string = TEMPLATE_ID): {
  params: Promise<{ id: string }>;
} {
  return { params: Promise.resolve({ id }) };
}

describe('F119 T108 — POST /api/broadcasts/templates/[id]/started', () => {
  beforeEach(() => {
    isF71aUs7EnabledMock.mockReturnValue(true);
    getCurrentSessionMock.mockResolvedValue({ user: { id: 'usr-1', role: 'member' } });
    checkLimitMock.mockResolvedValue({ ok: true });
    countTemplateStartMock.mockReset();
    countTemplateStartMock.mockResolvedValue(ok({ counted: true }));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('a template start counts once — one use-case call per request', async () => {
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );
    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(200);
    expect(countTemplateStartMock).toHaveBeenCalledTimes(1);
    const [, useCaseInput] = countTemplateStartMock.mock.calls[0] as [
      unknown,
      { templateId: string },
    ];
    expect(useCaseInput.templateId).toBe(TEMPLATE_ID);
  });

  it('no session → 401 and nothing is counted', async () => {
    getCurrentSessionMock.mockResolvedValue(null);
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );
    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(401);
    expect(countTemplateStartMock).not.toHaveBeenCalled();
  });

  it('flag off → 503 and nothing is counted', async () => {
    isF71aUs7EnabledMock.mockReturnValue(false);
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );
    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(503);
    expect(countTemplateStartMock).not.toHaveBeenCalled();
  });

  it('over the bucket → 429 and nothing is counted (a counter must not be inflatable)', async () => {
    checkLimitMock.mockResolvedValue({
      ok: false,
      error: { retryAfterSeconds: 42 },
    });
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );
    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(429);
    expect(countTemplateStartMock).not.toHaveBeenCalled();
  });

  it('template_not_found → 404, template_soft_deleted → 410', async () => {
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );

    countTemplateStartMock.mockResolvedValue(err({ kind: 'template_not_found' }));
    expect((await POST(makeRequest(), makeContext())).status).toBe(404);

    countTemplateStartMock.mockResolvedValue(
      err({ kind: 'template_soft_deleted' }),
    );
    expect((await POST(makeRequest(), makeContext())).status).toBe(410);
  });

  // The picker is shared by member compose and staff compose-on-behalf, so a
  // member session counts; a STAFF session counts only when it could have
  // composed at all (`broadcasts.write`, the permission the staff
  // compose-on-behalf draft route gates on). A read-only `manager` cannot
  // compose, so its "start" is not an adoption signal — it is inflation.
  it.each([
    ['member', 200],
    ['admin', 200],
    ['marketing', 200],
    ['super_admin', 200],
    ['manager', 403],
  ] as const)('%s session → %i', async (role, status) => {
    getCurrentSessionMock.mockResolvedValue({ user: { id: 'usr-1', role } });
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );
    const res = await POST(makeRequest(), makeContext());

    expect(res.status).toBe(status);
    expect(countTemplateStartMock).toHaveBeenCalledTimes(status === 200 ? 1 : 0);
  });

  it('a refused staff session consumes no rate-limit bucket', async () => {
    getCurrentSessionMock.mockResolvedValue({ user: { id: 'usr-1', role: 'manager' } });
    const { POST } = await import(
      '@/app/api/broadcasts/templates/[id]/started/route'
    );
    await POST(makeRequest(), makeContext());

    expect(checkLimitMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. The shipped path — the picker the member actually uses
// ---------------------------------------------------------------------------

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

/**
 * The real combobox popup deadlocks under jsdom + React 19 (see
 * `tests/unit/broadcast/template-picker-confirm.test.tsx`), so the picker is
 * replaced by plain buttons that call the SAME `onSelect(id)` contract. What
 * is under test is the counting call above the popup.
 */
vi.mock('@/components/broadcast/compose/template-picker', () => ({
  ComposeTemplatePicker: ({
    templates,
    onSelect,
  }: {
    templates: readonly { id: string; name: string }[];
    onSelect: (id: string | null) => void;
  }) =>
    createElement(
      'div',
      null,
      createElement(
        'button',
        { type: 'button', onClick: () => onSelect(null) },
        'pick-blank',
      ),
      ...templates.map((tpl) =>
        createElement(
          'button',
          { key: tpl.id, type: 'button', onClick: () => onSelect(tpl.id) },
          `pick-${tpl.id}`,
        ),
      ),
    ),
}));

const TEMPLATES = [
  {
    id: TEMPLATE_ID,
    name: 'Welcome',
    locale: 'en' as const,
    isSeeded: false,
    subject: 'S',
    bodyHtml: '<p>B</p>',
  },
  {
    id: OTHER_TEMPLATE_ID,
    name: 'Renewal',
    locale: 'en' as const,
    isSeeded: false,
    subject: 'S2',
    bodyHtml: '<p>B2</p>',
  },
];

function countCalls(fetchMock: ReturnType<typeof vi.fn>): string[] {
  return fetchMock.mock.calls
    .map(([url]) => String(url))
    .filter((url) => url.endsWith('/started'));
}

describe('F119 T108 — the compose template picker counts the start', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function renderPicker(): Promise<ReturnType<typeof vi.fn>> {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', fetchMock);
    const { ComposeTemplatePickerField } = await import(
      '@/components/broadcast/compose/template-picker-field'
    );
    render(
      createElement(ComposeTemplatePickerField, {
        templates: TEMPLATES,
        selectedId: null,
        hasContent: false,
        onApply: vi.fn(),
      }),
    );
    return fetchMock;
  }

  it('applying a template posts the count exactly once', async () => {
    const fetchMock = await renderPicker();

    fireEvent.click(screen.getByText(`pick-${TEMPLATE_ID}`));

    // The POST is issued synchronously from the click handler — no timers
    // involved, and `waitFor` would hang under the suite's fake clock.
    expect(countCalls(fetchMock)).toHaveLength(1);
    expect(countCalls(fetchMock)[0]).toBe(
      `/api/broadcasts/templates/${TEMPLATE_ID}/started`,
    );
  });

  it('re-picking the SAME template does not count twice', async () => {
    const fetchMock = await renderPicker();

    fireEvent.click(screen.getByText(`pick-${TEMPLATE_ID}`));
    expect(countCalls(fetchMock)).toHaveLength(1);
    fireEvent.click(screen.getByText(`pick-${TEMPLATE_ID}`));
    expect(countCalls(fetchMock)).toHaveLength(1);

    // …but a DIFFERENT template is a new start.
    fireEvent.click(screen.getByText(`pick-${OTHER_TEMPLATE_ID}`));
    expect(countCalls(fetchMock)).toHaveLength(2);
  });

  it('the blank option counts nothing', async () => {
    const fetchMock = await renderPicker();

    fireEvent.click(screen.getByText('pick-blank'));

    expect(countCalls(fetchMock)).toHaveLength(0);
  });
});
