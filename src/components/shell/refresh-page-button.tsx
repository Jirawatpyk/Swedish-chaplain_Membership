'use client';

/**
 * A "Refresh" control for a server-rendered page whose read failed and may
 * succeed on a retry (F119 UX review L12 — the portal E-Blast page's
 * "history could not be loaded" alert). `router.refresh()` re-runs the Server
 * Components in place, keeping client state and scroll.
 *
 * No live region of its own: the page it refreshes owns its announcements
 * (the sign-off page's stage banner is its one `role="status"`). While the
 * refresh runs the button says it is busy and stays focusable.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@jirawatpyk/aura-react';

export function RefreshPageButton({ label }: { readonly label: string }): React.ReactElement {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    // AURA's `loading` keeps the button focusable, says it is busy and
    // swallows repeat clicks — what `focusableWhenDisabled` did before.
    <Button
      type="button"
      variant="secondary"
      size="sm"
      icon="rotate-ccw"
      loading={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {label}
    </Button>
  );
}
