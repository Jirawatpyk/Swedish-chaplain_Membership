/**
 * F9 US5 (T083) — staff directory results table (FR-024). Presentational server
 * component: receives display-ready rows + localised labels. Listing status is
 * encoded with a text badge (not colour alone — WCAG 1.4.1).
 */
import { CheckIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shell/empty-state';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export interface DirectoryTableRow {
  readonly memberId: string;
  readonly companyName: string;
  readonly tier: string | null;
  readonly industry: string | null;
  readonly location: string | null;
  readonly listed: boolean;
  readonly hasLogo: boolean;
  readonly contactName: string | null;
}

export interface DirectoryTableLabels {
  readonly caption: string;
  readonly company: string;
  readonly tier: string;
  readonly industry: string;
  readonly location: string;
  readonly listed: string;
  readonly logo: string;
  readonly contact: string;
  readonly hasLogo: string;
  readonly yes: string;
  readonly no: string;
  readonly emptyTitle: string;
  readonly empty: string;
}

const DASH = '—';

export function DirectoryTable({
  rows,
  labels,
}: {
  readonly rows: readonly DirectoryTableRow[];
  readonly labels: DirectoryTableLabels;
}): React.JSX.Element {
  if (rows.length === 0) {
    return <EmptyState title={labels.emptyTitle} description={labels.empty} />;
  }

  return (
    <Table>
      <TableCaption className="sr-only">{labels.caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead>{labels.company}</TableHead>
          <TableHead>{labels.tier}</TableHead>
          <TableHead>{labels.industry}</TableHead>
          <TableHead>{labels.location}</TableHead>
          <TableHead>{labels.listed}</TableHead>
          <TableHead>{labels.logo}</TableHead>
          <TableHead>{labels.contact}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.memberId}>
            <TableCell className="font-medium">{row.companyName}</TableCell>
            <TableCell>{row.tier ?? DASH}</TableCell>
            <TableCell>{row.industry ?? DASH}</TableCell>
            <TableCell>{row.location ?? DASH}</TableCell>
            <TableCell>
              <Badge variant={row.listed ? 'default' : 'outline'}>
                {row.listed ? labels.yes : labels.no}
              </Badge>
            </TableCell>
            <TableCell>
              {row.hasLogo ? (
                <span className="inline-flex items-center gap-1 text-sm">
                  <CheckIcon className="size-4" aria-hidden />
                  <span className="sr-only">{labels.hasLogo}</span>
                </span>
              ) : (
                DASH
              )}
            </TableCell>
            <TableCell>{row.contactName ?? DASH}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
