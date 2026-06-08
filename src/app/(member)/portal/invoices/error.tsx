'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/**
 * Route-level error boundary for /portal/invoices — renders in the SAME
 * container as page.tsx + loading.tsx (DetailContainer, D4) so a runtime throw
 * lands at the matching width and doesn't shift relative to the portal shell.
 */
export default function PortalInvoicesError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[portal invoices error boundary]"
    />
  );
}
