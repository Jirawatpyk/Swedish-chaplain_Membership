/**
 * Spec 122 T006 — `tests/setup.ts` turns AURA's development warnings
 * (`[AURA] …`, e.g. a Select with no accessible name) into test failures, so
 * a migrated screen cannot ship an a11y misuse that only ever reached the
 * console. This is the positive control: it fails if the guard stops firing.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { Select } from '@jirawatpyk/aura-react';

describe('AURA dev-warning guard', () => {
  it('a Select with no accessible name fails the test', () => {
    expect(() => render(<Select options={['A', 'B']} />)).toThrow(/^\[AURA\] Select needs a label/);
  });

  it('a named Select renders quietly', () => {
    expect(() => render(<Select label="Plan" options={['A', 'B']} />)).not.toThrow();
  });

  it('other console warnings still pass through', () => {
    expect(() => console.warn('unrelated')).not.toThrow();
  });
});
