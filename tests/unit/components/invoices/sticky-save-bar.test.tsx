import { render, screen, fireEvent, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { StickySaveBar } from '@/components/invoices/invoice-settings/sticky-save-bar';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('is hidden when not visible', () => {
  const { container } = wrap(<StickySaveBar visible={false} submitting={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

it('calls onSave when the Save button is clicked', () => {
  const onSave = vi.fn();
  wrap(<StickySaveBar visible submitting={false} onSave={onSave} onDiscard={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
  expect(onSave).toHaveBeenCalled();
});

// Spec 122 US8c-2 (T857) — Discard (maintainer, 3 Oct).
it('calls onDiscard when Discard is clicked, and Discard is disabled while saving', () => {
  const onDiscard = vi.fn();
  const { rerender } = wrap(<StickySaveBar visible submitting={false} onSave={vi.fn()} onDiscard={onDiscard} />);
  const bar = screen.getByRole('region', { name: /save changes/i });
  fireEvent.click(within(bar).getByRole('button', { name: /discard/i }));
  expect(onDiscard).toHaveBeenCalled();
  rerender(
    <NextIntlClientProvider locale="en" messages={messages}>
      <StickySaveBar visible submitting onSave={vi.fn()} onDiscard={onDiscard} />
    </NextIntlClientProvider>,
  );
  expect(within(bar).getByRole('button', { name: /discard/i })).toBeDisabled();
});
