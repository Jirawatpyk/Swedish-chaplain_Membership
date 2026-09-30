/**
 * Cluster 7 (G19) — <TimelinePreviewSection> failure observability.
 *
 * Mirrors the portal precedent (D1 finding B2,
 * tests/unit/portal/dashboard/recent-activity-section.test.tsx): a failed
 * `timelineList` read must NOT fall open to the "No recent activity yet."
 * empty state (which lies — nothing happened, from the admin's view). The
 * section must render a DISTINCT "activity unavailable"
 * (`timelinePreview.loadFailed`) copy AND log the failure with errKind only
 * (never a raw error / PII).
 *
 * Server-component approach: the async RSC body is invoked directly and the
 * returned tree rendered with `renderToStaticMarkup`. `getTranslations` is
 * backed by the real `en.json` so a dangling t() ref surfaces as
 * "MISSING_KEY:". Infra deps are mocked.
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

const errorSpy = vi.fn();
vi.mock('@/lib/logger', () => ({
  logger: { error: (...args: unknown[]) => errorSpy(...args) },
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }),
}));

vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-test-1',
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, timeline: {} }),
}));

// `timelineList` is the read whose failure we drive.
const timelineListMock = vi.fn();
vi.mock('@/modules/members', () => ({
  timelineList: (...args: unknown[]) => timelineListMock(...args),
}));

import { TimelinePreviewSection } from '@/app/(staff)/admin/members/[memberId]/_components/timeline-preview-section';

async function renderSection(): Promise<string> {
  const tree = await TimelinePreviewSection({
    memberId: 'm1',
    actorUserId: 'u1',
    actorRole: 'admin',
  });
  // The section hands its data to the async `TimelinePreviewCard` (spec 122
  // US5b-1, shared with the preview route); resolve that one level too.
  const el = tree as ReactElement<Record<string, unknown>>;
  const card = typeof el.type === 'function'
    ? await (el.type as (p: unknown) => Promise<ReactElement>)(el.props)
    : el;
  return renderToStaticMarkup(card);
}

describe('<TimelinePreviewSection> — failure path (G19, mirrors portal B2)', () => {
  beforeEach(() => {
    errorSpy.mockClear();
    timelineListMock.mockReset();
  });

  it('renders the distinct loadFailed copy (NOT the empty state) when the use-case returns err', async () => {
    timelineListMock.mockResolvedValue({
      ok: false,
      error: { type: 'server_error', message: 'boom', cause: new Error('NeonDbError') },
    });
    const html = await renderSection();
    // Real-en copy for timelinePreview.loadFailed (apostrophe HTML-encoded).
    expect(html).toContain('load recent activity');
    // Must NOT show the empty-state copy.
    expect(html).not.toContain('No recent activity yet');
    expect(html).not.toContain('MISSING_KEY:');
    // Logged with errKind only — no raw error / PII (finding B2 discipline).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [ctx] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.errKind).toBe('Error');
    expect(ctx).not.toHaveProperty('err');
    expect(ctx).not.toHaveProperty('error');
  });

  it('renders the distinct loadFailed copy when the read THROWS', async () => {
    timelineListMock.mockRejectedValue(new TypeError('bad'));
    const html = await renderSection();
    expect(html).toContain('load recent activity');
    expect(html).not.toContain('No recent activity yet');
    expect(html).not.toContain('MISSING_KEY:');
    // Thrown error is logged by class only.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [ctx] = errorSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(ctx.errKind).toBe('TypeError');
    expect(ctx).not.toHaveProperty('err');
  });

  it('renders the empty-state copy on an empty (successful) read — regression guard', async () => {
    timelineListMock.mockResolvedValue({ ok: true, value: { events: [] } });
    const html = await renderSection();
    expect(html).toContain('No recent activity yet');
    // Empty success is NOT a failure — never the loadFailed copy.
    expect(html).not.toContain('load recent activity');
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

describe('<TimelinePreviewSection> on AURA (spec 122 US3)', () => {
  beforeEach(() => {
    timelineListMock.mockReset();
  });

  // 122 US5b-1 (board `Admin-member-detail`, UX review M8): the card is
  // "Timeline" — the name its "On this page" link uses — and "View all
  // activity →" is a quiet text link, not a second button.
  it('is an AURA card titled "Timeline" with a quiet "View all activity" link', async () => {
    timelineListMock.mockResolvedValue({ ok: true, value: { events: [], nextCursor: null } });
    const el = document.createElement('div');
    el.innerHTML = await renderSection();
    const card = el.querySelector('section.aura-card')!;
    expect(card).toHaveAttribute('aria-labelledby', 'member-timeline-preview-heading');
    const h2 = card.querySelector('h2.aura-card__title')!;
    expect(h2.id).toBe('member-timeline-preview-heading');
    expect(h2).toHaveTextContent(en.admin.members.detail.sectionLinks.timeline);
    const link = card.querySelector('a[href="/admin/members/m1/timeline"]')!;
    expect(link).toHaveTextContent(en.admin.members.detail.timelinePreview.viewAll);
    expect(link).toHaveClass('aura-btn', 'aura-btn--ghost');
  });
});
