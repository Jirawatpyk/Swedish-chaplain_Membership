'use client';

import { TableContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/**
 * Route-level error boundary for /portal/invoices — renders in the LIST
 * container (matches the page) so a runtime throw doesn't bubble to the root
 * portal boundary's narrower container.
 */
export default function PortalInvoicesError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={TableContainer}
      logTag="[portal invoices error boundary]"
    />
  );
}
