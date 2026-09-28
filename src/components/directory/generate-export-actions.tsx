'use client';

/**
 * F9 US5 (T083) — directory E-Book / JSON generate controls (FR-026/FR-027).
 * Posts to the enqueue route, toasts the queued/failed result, then refreshes
 * so the new job appears in the recent-exports list (ux-standards § 5).
 */
import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from '@/lib/toast';
import { BookIcon, FileJsonIcon } from 'lucide-react';
import { Button } from '@jirawatpyk/aura-react';

type ExportKind = 'directory_ebook' | 'directory_json';

export function GenerateExportActions(): React.JSX.Element {
  const t = useTranslations('admin.directory.generate');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  // Track which artefact is generating so only that button shows the spinner.
  const [pendingKind, setPendingKind] = useState<ExportKind | null>(null);

  function generate(kind: ExportKind) {
    setPendingKind(kind);
    startTransition(async () => {
      try {
        const res = await fetch('/api/admin/directory/exports', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ kind }),
        });
        if (!res.ok) {
          toast.error(t('failed'));
          return;
        }
        toast.success(t('queued'));
        router.refresh();
      } catch {
        toast.error(t('failed'));
      } finally {
        setPendingKind(null);
      }
    });
  }

  return (
    <>
      <Button
        variant="secondary"
        icon={<BookIcon aria-hidden="true" />}
        loading={pendingKind === 'directory_ebook'}
        disabled={isPending}
        onClick={() => generate('directory_ebook')}
      >
        {t('ebook')}
      </Button>
      <Button
        variant="secondary"
        icon={<FileJsonIcon aria-hidden="true" />}
        loading={pendingKind === 'directory_json'}
        disabled={isPending}
        onClick={() => generate('directory_json')}
      >
        {t('json')}
      </Button>
    </>
  );
}
