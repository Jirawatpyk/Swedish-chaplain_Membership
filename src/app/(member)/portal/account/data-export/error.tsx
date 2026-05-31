'use client';

import { DetailContainer } from '@/components/layout';
import { PortalRouteError } from '@/components/shell/portal-route-error';

/**
 * Route-level error boundary for /portal/account/data-export — uses the page's
 * own DetailContainer (72rem) so a thrown `listMemberDataExports` /
 * `findByLinkedUserId` does not bubble to the parent /portal/account error.tsx
 * (FormContainer 42rem) and cause a layout shift (staff-review I2/W6).
 */
export default function DataExportError(props: {
  error: Error & { digest?: string };
  reset: () => void;
}): React.JSX.Element {
  return (
    <PortalRouteError
      {...props}
      container={DetailContainer}
      logTag="[data export error boundary]"
    />
  );
}
