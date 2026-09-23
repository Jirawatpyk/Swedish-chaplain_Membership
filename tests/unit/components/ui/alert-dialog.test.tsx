/**
 * F119 UX review (HIGH) — the AlertDialog popup had no height cap, so on a
 * 320 × 568 phone the E-Blast cancel dialog (reason + typed subject) grew past
 * the viewport and its Confirm button was clipped off-screen, unreachable.
 * The primitive now caps itself at the dynamic viewport height minus a margin
 * and scrolls internally. jsdom does no layout, so the classes are the
 * observable contract.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

afterEach(() => {
  cleanup();
});

function popup(): HTMLElement {
  const el = document.querySelector('[data-slot="alert-dialog-content"]');
  if (!el) throw new Error('alert-dialog-content not rendered');
  return el as HTMLElement;
}

describe('AlertDialogContent — viewport height cap', () => {
  it('caps its height to the dynamic viewport and scrolls internally', () => {
    render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>Title</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    );
    expect(popup().className).toMatch(/(^|\s)max-h-\[calc\(100dvh-2rem\)\](\s|$)/);
    expect(popup().className).toMatch(/(^|\s)overflow-y-auto(\s|$)/);
  });
});
