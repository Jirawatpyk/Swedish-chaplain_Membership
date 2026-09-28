/**
 * Members Backup Export button (design 2026-07-07). Admin-only (the page
 * renders it only for role==='admin'; the route enforces regardless).
 * fetch→blob→anchor download so failures surface as a toast instead
 * of navigating the admin to a bare JSON error page. Row counts for the
 * success toast come from the route's X-*-Count headers.
 */
'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { DownloadIcon } from 'lucide-react';
import { toast } from '@/lib/toast';
import { Button } from '@jirawatpyk/aura-react';

const FILENAME_FALLBACK = 'members-backup.zip';

function filenameFromDisposition(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? FILENAME_FALLBACK;
}

export function ExportBackupButton() {
  const t = useTranslations('admin.members');
  const [busy, setBusy] = useState(false);

  async function handleClick() {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/members/export.zip');
      if (!res.ok) {
        toast.error(t('exportBackupError'));
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filenameFromDisposition(res.headers.get('Content-Disposition'));
      document.body.appendChild(a);
      a.click();
      a.remove();
      // R3-UX1 — defer revoke so iOS Safari + Android Chrome don't
      // cancel the download from synchronous revocation (mirrors
      // src/lib/download-pdf-client.ts).
      setTimeout(() => URL.revokeObjectURL(url), 100);
      toast.success(
        t('exportBackupSuccess', {
          members: res.headers.get('X-Members-Count') ?? '0',
          contacts: res.headers.get('X-Contacts-Count') ?? '0',
          invoices: res.headers.get('X-Invoices-Count') ?? '0',
        }),
      );
    } catch {
      toast.error(t('exportBackupError'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Button
      variant="secondary"
      icon={<DownloadIcon aria-hidden="true" />}
      loading={busy}
      disabled={busy}
      onClick={handleClick}
    >
      {t('exportBackup')}
    </Button>
  );
}
