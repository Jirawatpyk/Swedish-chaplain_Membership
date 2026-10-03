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

// Spec 122 US8c-2 (T856) — each section is an AURA card, focusable (the rail
// moves focus to it) and labelled by its h2.
it('renders the section as an AURA card labelled by its h2, the rail\'s focus target', () => {
  wrap(<DocumentNotesSection {...BASE_PROPS} />);
  const section = document.getElementById('notes');
  expect(section).not.toBeNull();
  expect(section).toHaveClass('aura-card');
  expect(section!.tagName).toBe('SECTION');
  expect(section).toHaveAttribute('tabindex', '-1');
  expect(section).toHaveAttribute('aria-labelledby', 'notes-heading');
  const heading = document.getElementById('notes-heading');
  expect(heading?.tagName).toBe('H2');
  expect(heading).toHaveTextContent('Document notes');
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

it('renders the four notes on AURA textareas, the counter under each', () => {
  wrap(<DocumentNotesSection {...BASE_PROPS} whtNoteEn="abc" />);
  for (const id of ['wht_th', 'wht_en', 'termination_notice_th', 'termination_notice_en']) {
    expect(document.getElementById(id)?.closest('.aura-field'), id).not.toBeNull();
  }
  expect(screen.getByLabelText(/wht note \(english\)/i)).toHaveAccessibleDescription('3/500');
});
