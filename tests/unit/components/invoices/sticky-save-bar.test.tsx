import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { StickySaveBar } from '@/components/invoices/invoice-settings/sticky-save-bar';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('is hidden when not visible', () => {
  const { container } = wrap(<StickySaveBar visible={false} submitting={false} exists onDiscard={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

// Maintainer, 3 Oct (UX review M4): the bar's Save is the form's submit.
it('renders Save as the form\'s submit button, Create settings on a first-ever save', () => {
  const { rerender } = wrap(<StickySaveBar visible submitting={false} exists onDiscard={vi.fn()} />);
  expect(screen.getByRole('button', { name: /^save settings$/i })).toHaveAttribute('type', 'submit');
  rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StickySaveBar visible submitting={false} exists={false} onDiscard={vi.fn()} />
    </NextIntlClientProvider>,
  );
  expect(screen.getByRole('button', { name: /^create settings$/i })).toHaveAttribute('type', 'submit');
});

// Spec 122 US8c-2 (T857) — Discard (maintainer, 3 Oct).
it('calls onDiscard when Discard is clicked, and Discard is disabled while saving', () => {
  const onDiscard = vi.fn();
  const { rerender } = wrap(<StickySaveBar visible submitting={false} exists onDiscard={onDiscard} />);
  const bar = screen.getByRole('region', { name: /save changes/i });
  fireEvent.click(within(bar).getByRole('button', { name: /discard/i }));
  expect(onDiscard).toHaveBeenCalled();
  rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StickySaveBar visible submitting exists onDiscard={onDiscard} />
    </NextIntlClientProvider>,
  );
  expect(within(bar).getByRole('button', { name: /discard/i })).toBeDisabled();
});

// Review 23 Oct (WCAG 2.4.11): with the form in one column the save bar is
// taller than the 5.5rem the stylesheet keeps clear (103px at 390, its status
// and buttons wrap), so a focused field slid under it. The bar keeps its own
// measured height clear while it shows, and gives the offset back when it goes.
it('keeps its measured height clear below a focused field while it shows', () => {
  const spy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { height: this.classList.contains('chamber-viewport-actionbar') ? 103 : 0 } as DOMRect;
  });
  // AURA's stylesheet makes the bar sticky; jsdom loads none.
  const sticky = document.head.appendChild(document.createElement('style'));
  sticky.textContent = '.chamber-viewport-actionbar { position: sticky; }';
  const root = document.documentElement;
  const { unmount } = wrap(<StickySaveBar visible submitting={false} exists onDiscard={vi.fn()} />);
  expect(root.style.scrollPaddingBottom).toBe('119px');
  unmount();
  expect(root.style.scrollPaddingBottom).toBe('');
  spy.mockRestore();
  sticky.remove();
});
