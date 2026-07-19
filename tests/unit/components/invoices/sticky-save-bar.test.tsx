import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { StickySaveBar } from '@/components/invoices/invoice-settings/sticky-save-bar';

const wrap = (ui: React.ReactNode) =>
  render(<NextIntlClientProvider locale="en" messages={messages}>{ui}</NextIntlClientProvider>);

it('is hidden when not visible', () => {
  const { container } = wrap(<StickySaveBar visible={false} submitting={false} onSave={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

it('calls onSave when the Save button is clicked', () => {
  const onSave = vi.fn();
  wrap(<StickySaveBar visible submitting={false} onSave={onSave} />);
  fireEvent.click(screen.getByRole('button', { name: /save/i }));
  expect(onSave).toHaveBeenCalled();
});
