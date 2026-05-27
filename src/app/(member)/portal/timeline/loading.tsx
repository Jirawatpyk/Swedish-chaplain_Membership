/**
 * Route-level loading skeleton for `/portal/timeline` (review-run C2).
 *
 * Mirrors the staff timeline loading state so the member portal shows a
 * shimmer skeleton (not a blank container) while the server component
 * resolves — ux-standards § 2.1, CLS = 0.
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
