/**
 * F9 US6 (staff-review I1/B1) — skeleton for the admin on-behalf GDPR card,
 * shown while `MemberDataExportSection`'s `listMemberDataExports` resolves so
 * the card loads independently and never blocks the member-detail render
 * (ux-standards § 2.4 — each card replaces its own skeleton).
 */
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function MemberDataExportSkeleton(): React.JSX.Element {
  return (
    <Card aria-hidden>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-4 w-full max-w-md" />
      </CardHeader>
      <CardContent className="space-y-4">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-5 w-28" />
        <Skeleton className="h-9 w-full" />
      </CardContent>
    </Card>
  );
}
