'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/** Route-level error boundary for /portal/change-requests (matches the page's DetailContainer). */
export default function PortalChangeRequestsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return <PortalRouteError {...props} container={DetailContainer} logTag="[portal change-requests error boundary]" />;
}
