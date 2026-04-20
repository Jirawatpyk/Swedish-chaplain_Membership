/**
 * Shimmer skeleton for the member-detail Invoices section — US7 AS1.
 *
 * Renders the same card chrome + table shape as `MemberInvoicesSection`
 * so the layout doesn't jump when the server stream completes. Per
 * `docs/ux-standards.md` § 2.1 — first meaningful paint under 100 ms
 * via Suspense fallback; the parent page's `getMember` no longer
 * blocks on invoice fetch.
 */
import { ReceiptIcon } from 'lucide-react';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function MemberInvoicesSkeleton(): React.ReactElement {
  return (
    <section aria-busy="true" aria-labelledby="member-invoices-heading">
      <Card>
        <CardHeader>
          <CardTitle
            id="member-invoices-heading"
            className="text-base flex items-center gap-2"
          >
            <ReceiptIcon className="size-4" aria-hidden="true" />
            <Skeleton className="h-4 w-24" />
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-3/4" />
          </div>
        </CardContent>
      </Card>
    </section>
  );
}
