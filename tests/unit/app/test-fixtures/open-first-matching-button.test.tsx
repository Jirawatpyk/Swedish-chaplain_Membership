/**
 * Spec 122 US8b (parity comment, 3 Oct) — the preview opens a dialog the way
 * an admin does, by clicking its trigger. The refund trigger renders inside a
 * Suspense boundary, so it can appear (or hydrate) after the opener has
 * mounted; the opener keeps trying until a dialog is open, then stops.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useState } from 'react';
import { OpenFirstMatchingButton } from '@/app/test-fixtures/aura-admin/invoice-previews';

function Trigger({ onClick }: { onClick: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="refund-dialog-trigger"
        onClick={() => {
          onClick();
          setOpen(true);
        }}
      >
        Issue refund…
      </button>
      {open ? <div role="alertdialog" aria-label="Issue refund?" /> : null}
    </>
  );
}

describe('OpenFirstMatchingButton', () => {
  it('clicks a trigger that appears after it mounts, and stops once the dialog is open', async () => {
    const onClick = vi.fn();
    const { rerender } = render(<OpenFirstMatchingButton testId="refund-dialog-trigger">{null}</OpenFirstMatchingButton>);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    rerender(
      <OpenFirstMatchingButton testId="refund-dialog-trigger">
        <Trigger onClick={onClick} />
      </OpenFirstMatchingButton>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
