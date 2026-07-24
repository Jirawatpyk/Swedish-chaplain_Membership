'use client';

/**
 * Client wrapper that wires MembersTable + BulkActionBar together.
 *
 * Admin users get selection checkboxes + inline edit + the bulk toolbar.
 * Manager users get a read-only table (FR-018 AS5: hidden, not disabled).
 */

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { InfoIcon } from 'lucide-react';
import {
  MembersTable,
  type MembersTableRow,
  type InlineEditResult,
} from '@/components/members/members-table';
import { BulkActionBar } from './bulk-action-bar';
import { TablePagination } from '@/components/layout/table-pagination';
import { useTranslations } from 'next-intl';

type Props = {
  readonly rows: readonly MembersTableRow[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly isAdmin: boolean;
};

export function DirectoryWithBulk({
  rows,
  page,
  pageSize,
  total,
  isAdmin,
}: Props) {
  const t = useTranslations('admin.members.inlineEdit');
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // Staff-review SS-1: memoise to avoid O(N·M) recomputation on every render.
  // Also index rows by id for O(1) lookup during mapping.
  const selectedCompanyNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) {
      byId.set(row.member_id, row.company_name);
    }
    return selectedIds
      .map((id) => byId.get(id))
      .filter((name): name is string => Boolean(name));
  }, [rows, selectedIds]);

  const handleClear = useCallback(() => setSelectedIds([]), []);

  const handleInlineEdit = useCallback(
    async (
      memberId: string,
      field: 'status' | 'country' | 'notes',
      value: string | null,
    ): Promise<InlineEditResult> => {
      try {
        const res = await fetch(`/api/members/${memberId}/inline-edit`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            // Round-2 review I-6: Idempotency-Key on inline-edit prevents
            // duplicate audit events when the network times out between
            // server commit and client response.
            'Idempotency-Key': crypto.randomUUID(),
          },
          body: JSON.stringify({ field, value }),
        });

        if (res.ok) {
          // Refresh server component so the directory reflects the new
          // status/country/notes — without this, the optimistic state
          // in the cell desyncs from the source of truth on next render.
          router.refresh();
          return { ok: true };
        }

        const body = await res.json();
        // Map the server error CODE to localized cell/toast copy — never
        // forward the server's raw English `error.message` (it carried a
        // dev-y "State transition failed: <code>" string). Unknown codes
        // fall back to the generic localized "save failed" message.
        const code = body.error?.code;
        const key = typeof code === 'string' ? `errors.${code}` : null;
        return {
          ok: false,
          error: key && t.has(key) ? t(key) : t('saveFailed'),
        };
      } catch {
        return { ok: false, error: t('networkError') };
      }
    },
    [t, router],
  );

  return (
    <>
      {/* C3 round-10 ui-design-specialist — manager banner. Without it
          the table looked identical to admin's first paint (same chevron
          hover hint + same status badge styling) so managers repeatedly
          tried to double-click cells and got nothing. Banner makes the
          read-only constraint explicit + points to the resolution path. */}
      {!isAdmin && <ManagerReadOnlyBanner />}
      <MembersTable
        rows={rows}
        nextCursor={null}
        total={total}
        enableSelection={isAdmin}
        onSelectionChange={isAdmin ? setSelectedIds : undefined}
        onInlineEdit={isAdmin ? handleInlineEdit : undefined}
      />
      <TablePagination page={page} pageSize={pageSize} total={total} />
      {isAdmin && (
        <BulkActionBar
          selectedIds={selectedIds}
          selectedCompanyNames={selectedCompanyNames}
          totalMatching={total}
          onClear={handleClear}
        />
      )}
    </>
  );
}

/**
 * Subtle banner above the manager directory table. Uses an Info icon
 * + muted-background so the banner doesn't dominate but is unmissable
 * on first visit. `role="note"` is the canonical "supplemental
 * information" landmark — the banner is static admin-handoff guidance,
 * not a live-region status update (so `role="status"` would be wrong).
 */
function ManagerReadOnlyBanner() {
  const t = useTranslations('admin.members.directory');
  // No `aria-label` on the note: it would equal the visible `<p>` text and a
  // screen reader would announce the region name AND its content (double-
  // announce). The visible `<p>` is the region's accessible content.
  return (
    <div
      role="note"
      className="flex items-start gap-3 rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
    >
      <InfoIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <p className="text-muted-foreground">{t('managerReadOnlyBanner')}</p>
    </div>
  );
}
