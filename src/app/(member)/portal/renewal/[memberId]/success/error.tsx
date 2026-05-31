'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/** Route-level error boundary for /portal/renewal/[memberId]/success. */
export default function PortalRenewalSuccessError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[portal renewal success error boundary]"
    />
  );
}
