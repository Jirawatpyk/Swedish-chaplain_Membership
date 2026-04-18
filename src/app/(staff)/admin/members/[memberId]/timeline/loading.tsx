/**
 * Route-level loading skeleton for `/admin/members/[memberId]/timeline`.
 *
 * Renders the TimelineSkeleton so the fallback matches the real page
 * shape (header row + card + vertical event list) for CLS = 0.
 */
import { DetailContainer } from '@/components/layout';
import { TimelineSkeleton } from '@/components/members/timeline-skeleton';

export default function Loading() {
  return (
    <DetailContainer>
      <TimelineSkeleton />
    </DetailContainer>
  );
}
