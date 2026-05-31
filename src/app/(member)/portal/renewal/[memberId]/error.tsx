'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/** Route-level error boundary for /portal/renewal/[memberId]. */
export default function PortalRenewalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[portal renewal error boundary]"
    />
  );
}
