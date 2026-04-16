'use client';

/**
 * Client wrapper that wires MembersTable + BulkActionBar together.
 *
 * Admin users get selection checkboxes + inline edit + the bulk toolbar.
 * Manager users get a read-only table (FR-018 AS5: hidden, not disabled).
 */

import { useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  MembersTable,
  type MembersTableRow,
  type InlineEditResult,
} from '@/components/members/members-table';
import { BulkActionBar } from './bulk-action-bar';
import { useTranslations } from 'next-intl';

type Props = {
  readonly rows: readonly MembersTableRow[];
  readonly nextCursor: string | null;
  readonly isAdmin: boolean;
};

export function DirectoryWithBulk({ rows, nextCursor, isAdmin }: Props) {
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
        return {
          ok: false,
          error: body.error?.message ?? t('saveFailed'),
        };
      } catch {
        return { ok: false, error: t('networkError') };
      }
    },
    [t, router],
  );

  return (
    <>
      <MembersTable
        rows={rows}
        nextCursor={nextCursor}
        enableSelection={isAdmin}
        onSelectionChange={isAdmin ? setSelectedIds : undefined}
        onInlineEdit={isAdmin ? handleInlineEdit : undefined}
      />
      {isAdmin && (
        <BulkActionBar
          selectedIds={selectedIds}
          selectedCompanyNames={selectedCompanyNames}
          onClear={handleClear}
        />
      )}
    </>
  );
}
