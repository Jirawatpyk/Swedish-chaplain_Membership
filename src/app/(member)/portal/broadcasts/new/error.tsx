'use client';

/**
 * Segment-scoped error boundary for the member compose page
 * (`/portal/broadcasts/new`). A throw from `computeQuotaCounter`, member
 * lookup, or `<ComposeForm />` surfaces here with a Retry + a "back to
 * E-Blasts" escape, instead of bubbling to the root portal boundary.
 *
 * T155 finding U11 — the container is `DetailContainer` (72 rem), matching
 * `page.tsx:282` and `loading.tsx:26`. It used to be `FormContainer` (42 rem),
 * a guaranteed width jump the moment the page threw — while `loading.tsx:17`
 * carried a comment asserting the three matched. The two-column compose layout
 * is the reason all three are on the detail tier (FR-050, ux-standards
 * § 18.2 exception).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { DetailContainer } from '@/components/layout';
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
      container={DetailContainer}
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
