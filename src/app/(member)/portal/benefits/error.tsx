'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/** Route-level error boundary for /portal/benefits (matches the page's DetailContainer). */
export default function PortalBenefitsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[portal benefits error boundary]"
    />
  );
}
