'use client';

/**
 * F119 T142 (US6-AS3, FR-047) — segment-scoped error boundary for
 * `/portal/broadcasts/[id]`.
 *
 * The page THROWS on a member lookup, a broadcast read or a body render that
 * fails in a way it cannot degrade (it never renders "no delivery yet" about
 * numbers it could not read). Before this file that throw bubbled to the root
 * portal boundary, which replaces the whole shell; now it lands here with the
 * portal shell intact and a route-scoped Retry, plus the same "back to
 * E-Blasts" escape the compose boundary offers.
 *
 * `DetailContainer` matches the sibling `page.tsx` + `loading.tsx` so the
 * error width never shifts against the content (the contract
 * `portal-route-error.tsx` exists to enforce).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
import { buttonVariants } from '@/components/ui/button';
import { PortalRouteError } from '@/components/shell/portal-route-error';

export default function BroadcastDetailError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const tBack = useTranslations('portal.broadcasts.detail');
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[portal/broadcasts/[id] error boundary]"
      actions={
        <Link
          href="/portal/benefits?tab=broadcasts"
          className={buttonVariants({ variant: 'outline' })}
        >
          {tBack('back')}
        </Link>
      }
    />
  );
}
