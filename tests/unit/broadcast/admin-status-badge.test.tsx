// @vitest-environment jsdom
/**
 * F119 T063 UX review H3 (T120's rule) — the staff stage badge must fit a
 * 320 px header in every locale. The SV `member_approved` label runs ~28 %
 * longer than EN; the chip truncates with the full label in a `title` rather
 * than overflow the header horizontally (WCAG 1.4.10).
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import svMessages from '@/i18n/messages/sv.json';
import { StatusBadge } from '@/components/broadcast/admin/status-badge';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async () => (key: string) => svMessages.admin.broadcasts.queue.status[key as 'member_approved']),
}));

describe('admin StatusBadge — long labels truncate with a title (H3)', () => {
  it('the SV member_approved chip is width-capped, truncates its label, and keeps the full label in a title', async () => {
    const label = svMessages.admin.broadcasts.queue.status.member_approved;
    const { container } = render(await StatusBadge({ status: 'member_approved' }));
    const badge = container.querySelector('[data-slot="badge"]')!;
    expect(badge).toHaveAttribute('title', label);
    expect(badge.className).toContain('max-w-full');
    const text = badge.querySelector('.truncate');
    expect(text).toHaveTextContent(label);
  });
});
