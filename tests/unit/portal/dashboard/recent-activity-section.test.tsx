/**
 * 057 D1 review finding B2 — <RecentActivitySection> failure observability.
 *
 * A failed `timelineList` read must NOT fall open to the "No activity yet"
 * empty state (which lies — nothing failed, from the member's view). The
 * section must (1) log the failure in the SERVER component with errKind +
 * requestId (never raw error / PII) and (2) render a DISTINCT "activity
 * unavailable" state (`activity.loadFailed`).
 *
 * Server-component approach: the async RSC body is invoked directly and the
 * returned tree rendered with `renderToStaticMarkup`. `getTranslations` is
 * backed by the real `en.json` so a dangling t() ref surfaces as
 * "MISSING_KEY:" (mirrors dashboard-loading.test.tsx). Infra deps are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import en from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>(
    (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
    obj,
  );
}

function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(en as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

// --- mocks ----------------------------------------------------------------

const warnSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { warn: (...args: unknown[]) => warnSpy(...args) },
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-test-1',
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, timeline: {} }),
}));

// `timelineList` is the read whose failure we drive. Default = a server_error
// Result with a `cause` so rootCause(error) → the underlying Error class.
const timelineListMock = vi.fn();
vi.mock('@/modules/members', () => ({
  timelineList: (...args: unknown[]) => timelineListMock(...args),
}));

import { RecentActivitySection } from '@/app/(member)/portal/_components/recent-activity-section';

async function renderSection(): Promise<string> {
  const tree = await RecentActivitySection({ userId: 'u1', memberId: 'm1' });
  return renderToStaticMarkup(tree as ReactElement);
}

describe('<RecentActivitySection> — failure path (finding B2)', () => {
  beforeEach(() => {
    warnSpy.mockClear();
    timelineListMock.mockReset();
  });

  it('renders the distinct loadFailed copy (NOT the empty state) on a failed read', async () => {
    timelineListMock.mockResolvedValue({
      ok: false,
      error: { type: 'server_error', message: 'boom', cause: new Error('NeonDbError') },
    });
    const html = await renderSection();
    // Real-en copy for activity.loadFailed (apostrophe HTML-encoded).
    expect(html).toContain('load your recent activity');
    // Must NOT show the empty state copy.
    expect(html).not.toContain('No activity yet');
    expect(html).not.toContain('MISSING_KEY:');
  });

  it('logs a warning with requestId + errKind only — no raw error / PII (finding B2)', async () => {
    timelineListMock.mockResolvedValue({
      ok: false,
      error: { type: 'server_error', message: 'boom', cause: new TypeError('bad') },
    });
    await renderSection();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [ctx, msg] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx).toMatchObject({ requestId: 'req-test-1' });
    // rootCause unwraps `.cause` → the real Error class.
    expect(ctx.errKind).toBe('TypeError');
    expect(ctx).not.toHaveProperty('err');
    expect(ctx).not.toHaveProperty('error');
    expect(ctx).not.toHaveProperty('message');
    expect(msg).toContain('dashboard-recent-activity');
  });

  it('does NOT log when the read succeeds (empty result is a normal state)', async () => {
    timelineListMock.mockResolvedValue({ ok: true, value: { events: [] } });
    const html = await renderSection();
    expect(warnSpy).not.toHaveBeenCalled();
    // Empty success → the "No activity yet" empty state, never loadFailed.
    expect(html).toContain('No activity yet');
  });
});
