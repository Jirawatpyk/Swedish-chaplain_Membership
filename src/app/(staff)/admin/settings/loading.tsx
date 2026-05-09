/**
 * Route-level loading skeleton for `/admin/settings` index. Matches
 * the page's `<DetailContainer>` width + 2-card grid shape so layout
 * shifts are minimal (CLS=0 per docs/ux-standards.md § 2.1).
 *
 * Wrapped in `<DetailContainer>` so `pnpm check:layout` invariant
 * (page+loading both use the same variant) holds.
 */
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export default function SettingsIndexLoading() {
  return (
    <DetailContainer>
      <PageHeader
        title={<Skeleton className="h-8 w-32" />}
        subtitle={<Skeleton className="h-4 w-72" />}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <Card key={i}>
            <CardHeader className="flex flex-row items-start gap-3 space-y-0">
              <Skeleton className="size-5 rounded-sm" />
              <div className="flex flex-col gap-2">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-56" />
              </div>
            </CardHeader>
            <CardContent />
          </Card>
        ))}
      </div>
    </DetailContainer>
  );
}
