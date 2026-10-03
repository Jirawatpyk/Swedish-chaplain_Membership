/**
 * Spec 122 US8b (parity comment, 3 Oct) — the preview opens a dialog the way
 * an admin does, by clicking its trigger. The refund trigger renders inside a
 * Suspense boundary, so it can appear (or hydrate) after the opener has
 * mounted; the opener keeps trying until a dialog is open, then stops.
 */
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { OpenFirstMatchingButton } from '@/app/test-fixtures/aura-admin/invoice-previews';

function LateTrigger({ onClick }: { onClick: () => void }) {
  const [shown, setShown] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(id);
  }, []);
  if (!shown) return null;
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
  it('clicks a trigger that appears after it mounts, once', async () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    render(
      <OpenFirstMatchingButton testId="refund-dialog-trigger">
        <LateTrigger onClick={onClick} />
      </OpenFirstMatchingButton>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(onClick).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
