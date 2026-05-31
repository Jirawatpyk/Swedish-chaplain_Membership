'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/**
 * Route-level error boundary for /portal/profile/directory (matches the
 * page's DetailContainer).
 */
export default function DirectorySettingsError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[directory settings error boundary]"
    />
  );
}
