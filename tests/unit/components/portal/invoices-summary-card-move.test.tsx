import { describe, it, expect } from 'vitest';

/**
 * G2 — locks the relocation of InvoicesSummaryCard to the shared
 * `src/components/portal/` path. The Dashboard (Task 25+) and the
 * Invoices page both import it from there. The old route-local path
 * must no longer export it (single source of truth).
 */
describe('InvoicesSummaryCard relocation', () => {
  it('is exported from the shared @/components/portal path', async () => {
    const mod = await import('@/components/portal/invoices-summary-card');
    expect(typeof mod.InvoicesSummaryCard).toBe('function');
  });

  it('is no longer exported from the old route-local _components path', async () => {
    // Use `new Function` to bypass Vite's static import-analysis, which would
    // fail at transform time when the module no longer exists — even inside
    // `.rejects.toThrow()`.  The runtime import throws ERR_MODULE_NOT_FOUND,
    // which is the GREEN assertion: the old route-local file is gone.
    const dynamicImport = new Function('m', 'return import(m)') as (
      m: string,
    ) => Promise<unknown>;
    await expect(
      dynamicImport(
        '@/app/(member)/portal/invoices/_components/invoices-summary-card',
      ),
    ).rejects.toThrow();
  });
});
