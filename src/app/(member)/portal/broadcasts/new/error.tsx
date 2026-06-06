'use client';

/**
 * Segment-scoped error boundary for the member compose page
 * (`/portal/broadcasts/new`). A throw from `computeQuotaCounter`, member
 * lookup, or `<ComposeForm />` surfaces here (FormContainer, matching the
 * page) with a Retry + a "back to E-Blasts" escape, instead of bubbling to
 * the root portal boundary.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { FormContainer } from '@/components/layout';
import { buttonVariants } from '@/components/ui/button';
import { PortalRouteError } from '@/components/shell/portal-route-error';

export default function ComposeBroadcastError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  const tBack = useTranslations('portal.broadcasts.detail');
  return (
    <PortalRouteError
      {...props}
      container={FormContainer}
      logTag="[portal/broadcasts/new error boundary]"
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
