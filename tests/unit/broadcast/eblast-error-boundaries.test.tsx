/**
 * F119 T135 (US6-AS3, FR-047) — every E-Blast route shows the platform's
 * error state with a retry.
 *
 * Before T142 only two of the seven E-Blast routes had a segment boundary
 * (`/portal/broadcasts/new` and `/admin/settings/broadcasts/brand`). A throw
 * anywhere else bubbled to the ROOT boundary, which replaces the whole shell:
 * the member or the operator lost the sidebar, the nav and the page they were
 * on, and got no route-scoped retry.
 *
 * The five boundaries this pins are asserted by IDENTITY, not by count — a
 * sixth route added later needs its own line here, and a count would have let
 * a rename swap one route for another silently.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import type { ComponentType } from 'react';

vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children?: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

type ErrorBoundary = ComponentType<{
  error: Error & { digest?: string };
  reset: () => void;
}>;

/**
 * The five routes that had no `error.tsx` before T142. Each entry is the
 * module specifier its `error.tsx` lives at — the identity the gate pins.
 */
const BOUNDARIES: ReadonlyArray<readonly [label: string, load: () => Promise<{ default: ErrorBoundary }>]> = [
  [
    '/portal/broadcasts/[id]',
    () => import('@/app/(member)/portal/broadcasts/[id]/error'),
  ],
  // T155 finding U10 — `/admin/broadcasts/new` had none and inherited the
  // QUEUE's, which renders `TableContainer` and the title "E-Blast review
  // queue" for a compose failure: wrong container tier, and a title naming
  // another page.
  [
    '/admin/broadcasts/new',
    () => import('@/app/(staff)/admin/broadcasts/new/error'),
  ],
  [
    '/admin/broadcasts',
    () => import('@/app/(staff)/admin/broadcasts/error'),
  ],
  [
    '/admin/broadcasts/[id]',
    () => import('@/app/(staff)/admin/broadcasts/[id]/error'),
  ],
  [
    '/admin/broadcasts/templates',
    () => import('@/app/(staff)/admin/broadcasts/templates/error'),
  ],
  [
    '/admin/settings/broadcasts',
    () => import('@/app/(staff)/admin/settings/broadcasts/error'),
  ],
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('F119 T135 — E-Blast route error boundaries (US6-AS3, FR-047)', () => {
  it.each(BOUNDARIES)(
    '%s renders the shared error state with a working retry',
    async (_label, load) => {
      const { default: Boundary } = await load();
      const reset = vi.fn();

      render(
        <Boundary
          error={Object.assign(new Error('boom'), { digest: 'abc123' })}
          reset={reset}
        />,
      );

      // The platform's error copy, not a route-local string.
      expect(screen.getAllByText('generic').length).toBeGreaterThan(0);
      // …and the error id, so a member can quote it to support.
      expect(screen.getByText('errorId')).toBeInTheDocument();

      // `fireEvent`, not `userEvent`: the shared `tests/setup.ts` installs
      // fake timers and userEvent's internal delay never advances under them.
      fireEvent.click(screen.getByRole('button', { name: 'retry' }));
      expect(reset).toHaveBeenCalledTimes(1);
    },
  );
});
