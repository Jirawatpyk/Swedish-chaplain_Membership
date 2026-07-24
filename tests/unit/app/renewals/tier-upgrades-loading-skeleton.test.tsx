/**
 * WP8 (BP5 item 2) — tier-upgrade loading skeleton CLS parity.
 *
 * The live page renders the queue in a `rounded-md border` wrapper (NOT a
 * Card) beneath a tab strip. The skeleton must mirror that shape so the loaded
 * table doesn't shift the layout. Async RSC body is invoked directly (mirrors
 * the portal dashboard-loading test).
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi
    .fn()
    .mockImplementation(async () => (key: string) => key),
}));

import Loading from '@/app/(staff)/admin/renewals/tier-upgrades/loading';

async function html(): Promise<string> {
  return renderToStaticMarkup((await Loading()) as ReactElement);
}

describe('tier-upgrades loading skeleton', () => {
  it('uses the rounded-md border wrapper the live page uses, not a Card', async () => {
    const out = await html();
    expect(out).not.toContain('data-slot="card"');
    expect(out).toContain('rounded-md border');
  });

  it('renders a static tab-strip skeleton ahead of the table', async () => {
    const out = await html();
    const tabIdx = out.indexOf('data-slot="tab-strip-skeleton"');
    const tableIdx = out.indexOf('rounded-md border');
    expect(tabIdx).toBeGreaterThanOrEqual(0);
    expect(tableIdx).toBeGreaterThan(tabIdx);
  });

  it('announces loading via a role=status live region', async () => {
    expect(await html()).toContain('role="status"');
  });

  it('keeps the table layout container (structural parity with the page)', async () => {
    const out = await html();
    expect(out).toContain('data-slot="layout-container"');
    expect(out).toContain('data-variant="table"');
  });

  it('mirrors the live 2-line reason cell to hold CLS (WP-P5)', async () => {
    const out = await html();
    // The reason column renders a dedicated 2-line skeleton block (reason label
    // + evidence sub-line), not a single line — one line under-measured the row.
    expect(out).toContain('data-slot="reason-skeleton"');
    // Proportional columns (grid-cols-12) replaced equal grid-cols-6.
    expect(out).toContain('grid-cols-12');
    expect(out).not.toContain('grid-cols-6');
  });
});
