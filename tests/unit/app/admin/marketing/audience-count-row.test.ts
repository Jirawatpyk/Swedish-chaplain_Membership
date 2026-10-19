/**
 * The audience count sits at the end of the filter row from 640px up at every
 * width, as "131 results" does on Members (maintainer, 19 Oct 2026). The count
 * stays the results' own element (the live region, silent at zero, and the
 * focus target when the last row leaves a filtered view): the results stream
 * in after the filters, so the card's body is a row in which the filter bar
 * takes the width the count leaves (its controls wrap inside it when they
 * must) and the count keeps its own width, aligned to the bar's first row.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const view = readFileSync(join(process.cwd(), 'src/app/(staff)/admin/marketing/audience/_components/audience-view.tsx'), 'utf8');
const filters = readFileSync(join(process.cwd(), 'src/app/(staff)/admin/marketing/audience/_components/audience-filters.tsx'), 'utf8');

describe('the audience count beside the filters', () => {
  it('from 640px the filters take the width the count leaves, so the count never drops under them', () => {
    expect(view).toMatch(/sm:flex-row sm:flex-wrap sm:items-start/);
    expect(view).toMatch(/sm:\[&>\*\]:basis-full/);
    expect(view).toMatch(/sm:\[&>\[data-audience-filters\]\]:basis-0/);
    expect(view).not.toMatch(/basis-\[max-content\]/);
    expect(view).toMatch(/sm:\[&>#audience-count\]:basis-auto/);
  });

  it("the count lines up with the bar's first row of controls (36px, 44px on touch)", () => {
    expect(view).toMatch(/sm:\[&>#audience-count\]:min-h-9/);
    expect(view).toMatch(/sm:pointer-coarse:\[&>#audience-count\]:min-h-11/);
  });

  it('the filters mark their root so the grid can place them', () => {
    expect(filters).toMatch(/data-audience-filters=""/);
  });
});
