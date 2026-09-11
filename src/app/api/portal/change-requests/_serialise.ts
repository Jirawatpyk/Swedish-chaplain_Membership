/**
 * F114 — portal `ChangeRequestView` serialiser. The implementation lives in
 * `src/lib/change-request-portal-view.ts` (shared with the portal pages);
 * this file keeps the route-local import short.
 */
export {
  serialiseChangeRequestForPortal,
  serialiseField,
  type ChangeRequestFieldView,
  type ChangeRequestView,
  type PortalSubmitter,
} from '@/lib/change-request-portal-view';
