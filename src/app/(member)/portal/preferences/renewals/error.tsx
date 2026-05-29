'use client';

import { FormContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/** Route-level error boundary for /portal/preferences/renewals (matches the page's FormContainer). */
export default function PortalRenewalPreferencesError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={FormContainer}
      logTag="[portal renewal preferences error boundary]"
    />
  );
}
