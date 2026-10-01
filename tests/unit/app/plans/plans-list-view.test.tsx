/**
 * `renderPlansListView` (spec 122 US6; maintainer, 1 Oct, as for the
 * renewal pipeline): the plans table is one AURA card on a desktop (board
 * `Admin-plans`); on a phone it has no frame, border or padding, so the row
 * cards sit on the 16px page gutter as `Admin-plans-mobile` and the members
 * list draw them, not 32px in.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/messages/en.json';
import { renderPlansListView } from '@/app/(staff)/admin/plans/_components/plans-list-view';

vi.mock('next-intl/server', () => ({
  getTranslations: async (ns: string) => {
    const scope = ns.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], en);
    return (key: string) =>
      key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], scope) as string;
  },
}));

describe('renderPlansListView — the table card', () => {
  it('drops its frame and its padding below 640px (AURA flushBelow, no padding or border)', async () => {
    render(await renderPlansListView({ canWrite: false, children: <p>PLANS TABLE</p> }));
    const card = screen.getByText('PLANS TABLE').closest('.aura-card');
    expect(card).toHaveClass('aura-card--flush-below-sm');
    expect(card).toHaveClass('max-sm:p-0', 'max-sm:border-0');
  });
});
