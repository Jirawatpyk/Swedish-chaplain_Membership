'use client';

/**
 * Client wrapper that wires MembersTable + BulkActionBar together.
 *
 * Admin users get selection checkboxes + inline edit + the bulk toolbar.
 * Manager users get a read-only table (FR-018 AS5: hidden, not disabled).
 */

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
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
  const tDir = useTranslations('admin.members.directory');
  const router = useRouter();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // #2 — cross-page "Select all N matching" selection, fetched from
  // /api/members/ids (capped at BULK_CAP). When set it OVERRIDES the per-page
  // selection so a bulk action reaches the whole filtered set, not just the 50
  // visible rows. It is only valid for the EXACT current view, so any fresh
  // server render (filter change, page change, router.refresh after a mutation)
  // drops it — otherwise a stale id set from the previous filter could act on
  // the wrong members.
  const [matching, setMatching] = useState<
    { ids: string[]; total: number; capped: boolean } | null
  >(null);
  // Reset the cross-page selection whenever a fresh server render arrives (a new
  // filter/page, or a router.refresh after a mutation) — the fetched ids are
  // only valid for the exact rows they were fetched against. React's documented
  // "adjust state during render" pattern (NOT an effect): it drops the stale set
  // before this render commits and avoids the cascading-render an effect causes.
  const [rowsSnapshot, setRowsSnapshot] = useState(rows);
  if (rows !== rowsSnapshot) {
    setRowsSnapshot(rows);
    setMatching(null);
  }

  // The effective bulk target: the cross-page matching set when active,
  // otherwise the per-page checkbox selection.
  const effectiveIds = matching?.ids ?? selectedIds;

  // Staff-review SS-1: memoise to avoid O(N·M) recomputation on every render.
  // Also index rows by id for O(1) lookup during mapping. Off-page matching ids
  // simply resolve to no name (the archive confirm dialog then lists the names
  // it can + shows the full count separately — acceptable).
  const selectedCompanyNames = useMemo(() => {
    const byId = new Map<string, string>();
    for (const row of rows) {
      byId.set(row.member_id, row.company_name);
    }
    return effectiveIds
      .map((id) => byId.get(id))
      .filter((name): name is string => Boolean(name));
  }, [rows, effectiveIds]);

  const handleClear = useCallback(() => {
    setSelectedIds([]);
    setMatching(null);
  }, []);

  // Banner "Select all N matching" — fetch the whole matching id set (capped at
  // BULK_CAP) for the current filter and switch to the cross-page selection.
  const handleSelectAllMatching = useCallback(async () => {
    try {
      const res = await fetch(`/api/members/ids${window.location.search}`);
      if (!res.ok) {
        toast.error(tDir('selectAllMatchingError'));
        return;
      }
      const body = (await res.json()) as {
        ids?: unknown;
        total?: unknown;
        capped?: unknown;
      };
      if (
        !Array.isArray(body.ids) ||
        body.ids.length === 0 ||
        typeof body.total !== 'number'
      ) {
        toast.error(tDir('selectAllMatchingError'));
        return;
      }
      setMatching({
        ids: body.ids as string[],
        total: body.total,
        capped: body.capped === true,
      });
    } catch {
      toast.error(tDir('selectAllMatchingError'));
    }
  }, [tDir]);

  const handleClearMatching = useCallback(() => setMatching(null), []);

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
        total={total}
        enableSelection={isAdmin}
        onSelectionChange={isAdmin ? setSelectedIds : undefined}
        onInlineEdit={isAdmin ? handleInlineEdit : undefined}
        onSelectAllMatching={isAdmin ? handleSelectAllMatching : undefined}
        matchingActive={matching !== null}
        matchingCount={matching?.ids.length}
        matchingTotal={matching?.total}
        matchingCapped={matching?.capped ?? false}
        onClearMatching={isAdmin ? handleClearMatching : undefined}
      />
      <TablePagination page={page} pageSize={pageSize} total={total} />
      {isAdmin && (
        <BulkActionBar
          selectedIds={effectiveIds}
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
