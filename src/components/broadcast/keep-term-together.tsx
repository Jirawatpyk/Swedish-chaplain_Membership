/**
 * Keeps the product name "E-Blast" on one line inside a heading.
 *
 * Browsers may break a line after a hard hyphen, so a narrow TH/SV heading
 * could render "E-" at the end of one line and "Blast" on the next. The term
 * is wrapped in a `whitespace-nowrap` span instead of being rewritten with a
 * non-breaking hyphen (U+2011): Thai web fonts often lack that glyph, and the
 * visible text stays byte-identical for search and text matchers.
 */
import { Fragment, type ReactNode } from 'react';

const TERM = 'E-Blast';

export function keepTermTogether(text: string): ReactNode {
  const parts = text.split(TERM);
  if (parts.length === 1) return text;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {i > 0 ? <span className="whitespace-nowrap">{TERM}</span> : null}
          {part}
        </Fragment>
      ))}
    </>
  );
}
