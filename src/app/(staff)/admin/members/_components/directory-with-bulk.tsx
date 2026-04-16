'use client';

/**
 * Client wrapper that wires MembersTable + BulkActionBar together.
 *
 * Admin users get selection checkboxes + inline edit + the bulk toolbar.
 * Manager users get a read-only table (FR-018 AS5: hidden, not disabled).
 */

import { useState, useCallback } from 'react';
import { MembersTable, type MembersTableRow } from '@/components/members/members-table';
import { BulkActionBar } from './bulk-action-bar';
import { useTranslations } from 'next-intl';

type Props = {
  readonly rows: readonly MembersTableRow[];
  readonly nextCursor: string | null;
  readonly isAdmin: boolean;
};

export function DirectoryWithBulk({ rows, nextCursor, isAdmin }: Props) {
  const t = useTranslations('admin.members.inlineEdit');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const selectedCompanyNames = selectedIds
    .map((id) => rows.find((r) => r.member_id === id)?.company_name)
    .filter(Boolean) as string[];

  const handleClear = useCallback(() => setSelectedIds([]), []);

  const handleInlineEdit = useCallback(
    async (
      memberId: string,
      field: 'status' | 'country' | 'notes',
      value: string | null,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const res = await fetch(`/api/members/${memberId}/inline-edit`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field, value }),
        });

        if (res.ok) {
          return { ok: true };
        }

        const body = await res.json();
        return { ok: false, error: body.error?.message ?? t('saveFailed') };
      } catch {
        return { ok: false, error: t('networkError') };
      }
    },
    [t],
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
