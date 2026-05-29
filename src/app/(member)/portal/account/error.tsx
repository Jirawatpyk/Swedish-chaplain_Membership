'use client';

import { FormContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/** Route-level error boundary for /portal/account (matches the page's FormContainer). */
export default function PortalAccountError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={FormContainer}
      logTag="[portal account error boundary]"
    />
  );
}
