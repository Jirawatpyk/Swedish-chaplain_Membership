'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/**
 * Root error boundary for the member portal (`/portal/**`). DetailContainer
 * (72rem) per F5 Content-Type Mapping.
 */
export default function PortalError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[portal error boundary]"
    />
  );
}
