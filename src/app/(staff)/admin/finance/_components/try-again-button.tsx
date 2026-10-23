'use client';

/**
 * 124 US5.3 — a failed card's Try again: re-renders the page on the server,
 * which re-runs every loader (the other cards were fine and stay so).
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@jirawatpyk/aura-react';

export function TryAgainButton({ label }: { readonly label: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="secondary"
      size="sm"
      touchHeight
      icon="rotate-ccw"
      loading={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {label}
    </Button>
  );
}
