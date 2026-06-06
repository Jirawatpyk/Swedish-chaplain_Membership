import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

/**
 * G2 — locks the relocation of InvoicesSummaryCard to the shared
 * `src/components/portal/` path. The Dashboard (Task 25+) and the
 * Invoices page both import it from there. The old route-local path
 * must no longer exist (single source of truth).
 */
describe('InvoicesSummaryCard relocation', () => {
  it('is exported from the shared @/components/portal path', async () => {
    const mod = await import('@/components/portal/invoices-summary-card');
    expect(typeof mod.InvoicesSummaryCard).toBe('function');
  });

  it('no longer exists at the old route-local _components path', () => {
    // 057 review F12 — the prior `new Function('m','return import(m)')` guard
    // was FALSE-GREEN: a `@/`-aliased specifier rejects at runtime for ANY
    // path (Node can't resolve the Vite alias), so the assertion passed even
    // if the old file still existed. Assert on disk instead — the only real
    // signal that the file was actually deleted.
    const base = resolve(
      process.cwd(),
      'src/app/(member)/portal/invoices/_components/invoices-summary-card',
    );
    expect(existsSync(`${base}.tsx`)).toBe(false);
    expect(existsSync(`${base}.ts`)).toBe(false);
  });
});
