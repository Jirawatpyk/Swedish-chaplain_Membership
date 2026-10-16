/**
 * `<DocumentNumberHeading>` — a page title that carries a document number
 * (an invoice's SC-2026-000130, a credit note's CN-2026-000014).
 *
 * The number is an inline box: it moves to its own line as a whole rather
 * than breaking at its hyphens (R48, 320px), and breaks inside only when it
 * alone is wider than the line, so a 32px default font never widens the page
 * (R50: 435px at 390). One component for every document page, so a fix lands
 * on all of them (#547 fixed the credit note; #561 then reintroduced the
 * no-wrap number on the invoice).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { DOCUMENT_NUMBER_SLOT, DocumentNumberHeading } from '@/components/layout/document-number-heading';

afterEach(cleanup);

describe('<DocumentNumberHeading>', () => {
  it('puts the number where the locale puts it, in its own box', () => {
    const { container } = render(
      <h1>
        <DocumentNumberHeading template={`Invoice ${DOCUMENT_NUMBER_SLOT}`} number="SC-2026-000130" />
      </h1>,
    );
    expect(container.querySelector('h1')).toHaveTextContent(/^Invoice SC-2026-000130$/);
    const num = screen.getByText('SC-2026-000130');
    expect(num.tagName).toBe('SPAN');
    expect(num).toHaveClass('inline-block', 'max-w-full', '[overflow-wrap:anywhere]');
    expect(num).not.toHaveClass('whitespace-nowrap');
  });

  it('keeps words after the number (a locale that puts it first)', () => {
    const { container } = render(
      <h1>
        <DocumentNumberHeading template={`${DOCUMENT_NUMBER_SLOT} ใบแจ้งหนี้`} number="SC-2026-000130" />
      </h1>,
    );
    expect(container.querySelector('h1')).toHaveTextContent(/^SC-2026-000130 ใบแจ้งหนี้$/);
  });

  it('a template without the slot still shows the number, after the words', () => {
    const { container } = render(
      <h1>
        <DocumentNumberHeading template="Credit note" number="CN-2026-000014" />
      </h1>,
    );
    expect(container.querySelector('h1')).toHaveTextContent(/^Credit note CN-2026-000014$/);
  });
});
