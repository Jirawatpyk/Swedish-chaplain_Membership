/**
 * F119 T122a (PR-1, owner) · T122 (PR-2 extends) — the F119 metric
 * registrations in `src/lib/metrics.ts` (`contracts/dashboard-and-notifications.md`
 * § 4.2 — "a metric not on the registration list does not exist", and an
 * emit against an unregistered field does not typecheck).
 *
 * PR-1 registers the two preview instruments T032 emits:
 *   counter   broadcasts_preview_rendered_total{tenant,surface}
 *   histogram broadcasts_preview_render_ms{tenant}
 * PR-2 (T122) adds the five workflow counters and `broadcasts_member_decide_ms`.
 *
 * Fake meter harness mirrors `tests/unit/lib/metrics-auto-invoice.test.ts`:
 * it captures every `Counter.add` / `Histogram.record` by instrument name so
 * the NAME, the label KEYS and the VALUES are pinned here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface CapturedAdd {
  readonly value: number;
  readonly attrs: Record<string, unknown>;
}
const counterAdds = new Map<string, CapturedAdd[]>();
const histogramRecords = new Map<string, CapturedAdd[]>();

function bucket(map: Map<string, CapturedAdd[]>, name: string): CapturedAdd[] {
  let b = map.get(name);
  if (!b) {
    b = [];
    map.set(name, b);
  }
  return b;
}

vi.mock('@opentelemetry/api', async () => {
  const actual = await vi.importActual<typeof import('@opentelemetry/api')>('@opentelemetry/api');
  return {
    ...actual,
    metrics: {
      getMeter: () => ({
        createCounter: (name: string) => ({
          add: (value: number, attrs: Record<string, unknown>) => {
            bucket(counterAdds, name).push({ value, attrs });
          },
        }),
        createHistogram: (name: string) => ({
          record: (value: number, attrs: Record<string, unknown>) => {
            bucket(histogramRecords, name).push({ value, attrs });
          },
        }),
        createObservableGauge: () => ({ addCallback: () => {} }),
      }),
    },
  };
});
vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// Import AFTER vi.mock so the module picks up the fake meter.
import { broadcastsMetrics } from '@/lib/metrics';
import { renderBroadcastPreview } from '@/modules/broadcasts/application/use-cases/render-broadcast-preview';

const TENANT = 'tenant-f119';

beforeEach(() => {
  counterAdds.clear();
  histogramRecords.clear();
});

describe('T122a — preview metrics registration (PR-1)', () => {
  it('previewRendered emits `broadcasts_preview_rendered_total{tenant,surface}`', () => {
    broadcastsMetrics.previewRendered(TENANT, 'member');
    broadcastsMetrics.previewRendered(TENANT, 'staff');
    // ROUND-3 #11 — the two DETAIL read-backs get their own label; folded into
    // `member` / `staff` a per-page-view render was indistinguishable from a
    // per-keystroke compose render.
    broadcastsMetrics.previewRendered(TENANT, 'detail');
    expect(counterAdds.get('broadcasts_preview_rendered_total')).toEqual([
      { value: 1, attrs: { tenant: TENANT, surface: 'member' } },
      { value: 1, attrs: { tenant: TENANT, surface: 'staff' } },
      { value: 1, attrs: { tenant: TENANT, surface: 'detail' } },
    ]);
  });

  it('previewRenderMs records `broadcasts_preview_render_ms{tenant,surface}` in ms', () => {
    broadcastsMetrics.previewRenderMs(TENANT, 42, 'member');
    broadcastsMetrics.previewRenderMs(TENANT, 7, 'detail');
    expect(histogramRecords.get('broadcasts_preview_render_ms')).toEqual([
      { value: 42, attrs: { tenant: TENANT, surface: 'member' } },
      { value: 7, attrs: { tenant: TENANT, surface: 'detail' } },
    ]);
  });

  it('a preview render increments the counter exactly once and records the histogram', async () => {
    const r = await renderBroadcastPreview(
      {
        sanitizer: { sanitize: (html: string) => html },
        brand: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
        renderer: { render: () => '<!doctype html><html></html>' },
      },
      {
        tenantId: TENANT as never,
        tenantDisplayName: 'T',
        subject: 'S',
        bodyHtml: '<p>x</p>',
        locale: 'en',
        surface: 'member',
      },
    );
    expect(r.ok).toBe(true);
    expect(counterAdds.get('broadcasts_preview_rendered_total')).toEqual([
      { value: 1, attrs: { tenant: TENANT, surface: 'member' } },
    ]);
    const recs = histogramRecords.get('broadcasts_preview_render_ms');
    expect(recs).toHaveLength(1);
    expect(recs![0]!.attrs).toEqual({ tenant: TENANT, surface: 'member' });
    expect(recs![0]!.value).toBeGreaterThanOrEqual(0);
  });

  it('a refused render (body over the cap) emits neither instrument', async () => {
    const r = await renderBroadcastPreview(
      {
        sanitizer: { sanitize: (html: string) => html },
        brand: { load: async () => ({ primaryColor: null, postalAddress: null, logoUrl: null }) },
        renderer: { render: () => '' },
      },
      {
        tenantId: TENANT as never,
        tenantDisplayName: 'T',
        subject: 'S',
        bodyHtml: '<p>' + 'x'.repeat(201 * 1024) + '</p>',
        locale: 'en',
        surface: 'staff',
      },
    );
    expect(r.ok).toBe(false);
    expect(counterAdds.get('broadcasts_preview_rendered_total')).toBeUndefined();
    expect(histogramRecords.get('broadcasts_preview_render_ms')).toBeUndefined();
  });
});
