/**
 * 122 US6 (T607, parity) — board `Admin-plans-clone-mobile`: on a phone the
 * clone card drops its frame (AURA `flushBelow`), so its action bar can pin
 * edge to edge as the other plan forms' do, not inside the card's border.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/app/(staff)/admin/plans/clone/clone-year-client', () => ({
  CloneYearClient: () => <div data-testid="clone-client" />,
}));

import { renderCloneYearView } from '@/app/(staff)/admin/plans/_components/plan-form-views';

describe('renderCloneYearView', () => {
  it('puts the clone form in a card that drops its frame on phones', async () => {
    const { getByTestId } = render(
      await renderCloneYearView({ sourceYear: 2026, targetYear: 2027, currencyCode: 'THB', sourcePlans: [] }),
    );
    const card = getByTestId('clone-client').closest('.aura-card');
    expect(card).not.toBeNull();
    expect(card!.className).toMatch(/aura-card--flush-below-sm/);
  });
});
