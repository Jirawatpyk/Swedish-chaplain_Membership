/**
 * Suspense fallback for the member-detail GDPR data-export card (F9 US6):
 * the shared AURA section skeleton (spec 122 US5b-1), so the layout does not
 * jump when the export list streams in.
 */
import { SectionCardSkeleton } from './section-card-skeleton';

export function MemberDataExportSkeleton(): React.JSX.Element {
  return <SectionCardSkeleton rows={2} action />;
}
