/**
 * Route-level loading skeleton for `/portal/benefits` (ux-standards § 2.1).
 * Same DetailContainer as the page so the shimmer → content swap is CLS = 0.
 */
import { DetailContainer } from '@/components/layout';
import { BenefitUsageSkeleton } from '@/components/benefits/benefit-usage-skeleton';

export default function Loading() {
  return (
    <DetailContainer>
      <BenefitUsageSkeleton />
    </DetailContainer>
  );
}
