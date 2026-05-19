/**
 * T075 loading skeleton — paired with page.tsx so `pnpm check:layout`
 * passes (every page/loading pair MUST use the same layout container).
 */
import { FormContainer } from '@/components/layout';
import { Skeleton } from '@/components/ui/skeleton';

export default function Loading(): React.ReactElement {
  return (
    <FormContainer>
      <Skeleton className="h-8 w-1/2" />
      <Skeleton className="h-4 w-3/4 mt-2" />
      <div className="mt-6 space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </FormContainer>
  );
}
