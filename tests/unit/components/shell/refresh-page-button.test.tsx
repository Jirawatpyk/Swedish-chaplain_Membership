import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { RefreshPageButton } from '@/components/shell/refresh-page-button';

describe('RefreshPageButton', () => {
  // Spec 122 US12c-2 (UX review M2) — the only way out of a failed read on a
  // phone, so it takes the 44px touch height.
  it('takes the touch height', () => {
    render(<RefreshPageButton label="Refresh" />);
    expect(screen.getByRole('button', { name: 'Refresh' }).className).toContain('aura-btn--touch');
  });
});
