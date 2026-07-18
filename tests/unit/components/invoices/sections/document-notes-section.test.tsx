import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import {
  DocumentNotesSection,
  type DocumentNotesSectionProps,
} from '@/components/invoices/invoice-settings/sections/document-notes-section';

const BASE_PROPS: DocumentNotesSectionProps = {
  whtNoteTh: '',
  onWhtNoteThChange: vi.fn(),
  whtNoteEn: '',
  onWhtNoteEnChange: vi.fn(),
  terminationNoticeTh: '',
  onTerminationNoticeThChange: vi.fn(),
  terminationNoticeEn: '',
  onTerminationNoticeEnChange: vi.fn(),
  disabled: false,
};

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

it('renders the section root (id "notes", not "document-notes") with the nav-targeted heading', () => {
  wrap(<DocumentNotesSection {...BASE_PROPS} />);
  const section = document.getElementById('notes');
  expect(section).not.toBeNull();
  const heading = section?.querySelector('[data-section-heading]');
  expect(heading).toHaveAttribute('id', 'notes-heading');
  expect(heading).toHaveAttribute('tabindex', '-1');
});

it('renders the WHT note field with a char counter', () => {
  wrap(<DocumentNotesSection {...BASE_PROPS} whtNoteTh="test" />);
  expect(screen.getByLabelText(/wht note \(thai\)/i)).toHaveValue('test');
  expect(screen.getByText('4/500')).toBeInTheDocument();
});

it('renders the termination notice fields', () => {
  wrap(<DocumentNotesSection {...BASE_PROPS} />);
  expect(screen.getByLabelText(/termination notice \(thai\)/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/termination notice \(english\)/i)).toBeInTheDocument();
});

// I2 (wave B) — auto_email_enabled relocated OUT of this section into
// numbering-section.tsx's "Defaults" area (it's a send-behaviour default,
// not a note). See sections/numbering-section.test.tsx for its coverage.
it('no longer renders the auto-email switch (relocated to NumberingSection)', () => {
  wrap(<DocumentNotesSection {...BASE_PROPS} />);
  expect(screen.queryByRole('switch', { name: /auto-email on issue\/payment/i })).not.toBeInTheDocument();
});
