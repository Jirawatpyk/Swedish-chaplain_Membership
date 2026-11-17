/**
 * AURA 5.91 #211 — a list's Clear handler lives in the component that renders
 * `<FilterBar>`, outside the Filters sheet's context, so it reads the sheet
 * through a bridge mounted as one of the bar's children.
 */
import { createRef } from 'react';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const sheet = { inSheet: true, focusDone: vi.fn() };
vi.mock('@jirawatpyk/aura-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@jirawatpyk/aura-react')>()),
  useFilterBarSheet: () => sheet,
}));

import { FilterSheetBridge, type FilterSheetHandle } from '@/components/shell/filter-sheet-bridge';

describe('FilterSheetBridge', () => {
  it('exposes the sheet API it is mounted in, and renders nothing', () => {
    const ref = createRef<FilterSheetHandle>();
    const { container } = render(<FilterSheetBridge ref={ref} />);
    expect(container.innerHTML).toBe('');
    expect(ref.current?.inSheet).toBe(true);
    ref.current?.focusDone();
    expect(sheet.focusDone).toHaveBeenCalledTimes(1);
  });

  it('reads not-in-sheet outside a Filters sheet', async () => {
    vi.resetModules();
    vi.doUnmock('@jirawatpyk/aura-react');
    const { FilterSheetBridge: Real } = await import('@/components/shell/filter-sheet-bridge');
    const ref = createRef<FilterSheetHandle>();
    render(<Real ref={ref} />);
    expect(ref.current?.inSheet).toBe(false);
    expect(() => ref.current?.focusDone()).not.toThrow();
  });
});
