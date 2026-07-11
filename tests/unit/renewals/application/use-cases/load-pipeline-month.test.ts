import { describe, expect, it, vi } from 'vitest';
import { loadPipeline } from '@/modules/renewals/application/use-cases/load-pipeline';

function makeDeps() {
  const loadPipelinePage = vi.fn().mockResolvedValue({
    rows: [],
    nextCursor: null,
    summary: {
      totalInWindow: 0,
      byUrgency: { 't-90': 0, 't-60': 0, 't-30': 0, 't-14': 0, 't-7': 0, 't-0': 0, grace: 0, lapsed: 0 },
      lapsedCount: 0,
    },
  });
  return { deps: { cyclesRepo: { loadPipelinePage } } as never, loadPipelinePage };
}

const NOW = '2026-07-10T05:00:00Z';

describe('loadPipeline — month vs urgency precedence', () => {
  it('a valid month forwards monthFilter+nowIso and DROPS urgency', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, {
      tenantId: 't1',
      urgency: 't-30',
      month: '2027-02',
      nowIso: NOW,
      limit: 50,
    });
    const opts = loadPipelinePage.mock.calls[0]![1];
    expect(opts.monthFilter).toBe('2027-02');
    expect(opts.nowIso).toBe(NOW);
    expect(opts.urgency).toBeUndefined();
  });

  it('overdue / later are valid month keys', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, { tenantId: 't1', month: 'overdue', nowIso: NOW, limit: 50 });
    expect(loadPipelinePage.mock.calls[0]![1].monthFilter).toBe('overdue');
  });

  it('an invalid month is ignored and urgency is honoured', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, {
      tenantId: 't1',
      urgency: 't-7',
      month: '2026-13',
      nowIso: NOW,
      limit: 50,
    });
    const opts = loadPipelinePage.mock.calls[0]![1];
    expect(opts.monthFilter).toBeUndefined();
    expect(opts.urgency).toBe('t-7');
  });

  it('a valid month with NO nowIso falls back to urgency (defensive)', async () => {
    const { deps, loadPipelinePage } = makeDeps();
    await loadPipeline(deps, { tenantId: 't1', urgency: 't-7', month: '2027-02', limit: 50 });
    const opts = loadPipelinePage.mock.calls[0]![1];
    expect(opts.monthFilter).toBeUndefined();
    expect(opts.urgency).toBe('t-7');
  });
});
