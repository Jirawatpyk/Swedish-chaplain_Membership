import type { ReactNode } from 'react';

/**
 * Where the document number goes in a translated title: pass it as the
 * number to `t()`, then hand the result to `<DocumentNumberHeading>`.
 */
export const DOCUMENT_NUMBER_SLOT = '\u0000';

/**
 * A page title that carries a document number (an invoice's SC-2026-000130,
 * a credit note's CN-2026-000014), in the order the locale puts it.
 *
 * The number is an inline box: it moves to its own line as a whole instead of
 * breaking at its hyphens (R48, 320px), and breaks inside only when it alone
 * is wider than the line, so a 32px default font never widens the page (R50).
 * Every document page uses this one component, and
 * `tests/unit/architecture/document-number-heading.test.ts` keeps it that way:
 * #547 fixed the credit note's no-wrap number, then #561 gave the invoice its
 * own and the bug came back.
 */
export function DocumentNumberHeading({ template, number }: { readonly template: string; readonly number: string }): ReactNode {
  const at = template.indexOf(DOCUMENT_NUMBER_SLOT);
  const before = at < 0 ? `${template} ` : template.slice(0, at);
  const after = at < 0 ? '' : template.slice(at + DOCUMENT_NUMBER_SLOT.length);
  return (
    <>
      {before}
      <span className="inline-block max-w-full [overflow-wrap:anywhere]">{number}</span>
      {after}
    </>
  );
}
