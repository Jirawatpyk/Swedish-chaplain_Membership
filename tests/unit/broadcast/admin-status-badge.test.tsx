// @vitest-environment jsdom
/**
 * The staff stage badge on the E-Blast detail page.
 *
 * Spec 122 US12c-1 (T1222) — the header shows the stage as the queue does: an
 * AURA `StatusPill` in the tone `getBroadcastStatusTone` gives that stage, so
 * one stage reads the same in the list and on its page.
 *
 * F119 T063 UX review H3 (T120's rule) — the badge must fit a 320 px header in
 * every locale. The SV `member_approved` label runs ~28 % longer than EN; the
 * pill wraps its words inside itself (`wrap`, AURA 5.51 #158) rather than
 * overflow the header horizontally (WCAG 1.4.10), so nothing is cut off.
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import svMessages from '@/i18n/messages/sv.json';
import { StatusBadge } from '@/components/broadcast/admin/status-badge';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(
    async () => (key: string) =>
      svMessages.admin.broadcasts.queue.status[key as keyof typeof svMessages.admin.broadcasts.queue.status],
  ),
}));

describe('admin StatusBadge — the stage as an AURA status pill', () => {
  it('renders the stage word in an AURA status pill, in the tone the queue uses', async () => {
    const { container } = render(await StatusBadge({ status: 'failed_to_dispatch' }));
    const pill = container.querySelector('.aura-pill');
    expect(pill).not.toBeNull();
    expect(pill!.className).toContain('aura-pill--blocked');
    expect(pill).toHaveTextContent(svMessages.admin.broadcasts.queue.status.failed_to_dispatch);
    expect(container.querySelector('[data-slot="badge"]')).toBeNull();
  });

  it('a long SV label wraps inside the pill instead of being cut off (H3)', async () => {
    const label = svMessages.admin.broadcasts.queue.status.member_approved;
    const { container } = render(await StatusBadge({ status: 'member_approved' }));
    const pill = container.querySelector('.aura-pill')!;
    expect(pill.className).toContain('is-wrap');
    expect(pill).toHaveTextContent(label);
    expect(container.querySelector('.truncate')).toBeNull();
  });
});
