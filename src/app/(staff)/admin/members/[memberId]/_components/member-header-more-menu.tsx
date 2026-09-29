'use client';

/**
 * 122 US5b-1 — the member header's ⋯ menu on a phone (board
 * `Admin-member-detail-mobile`; maintainer, 29 Sep): Erase and Archive sit
 * here below `sm`, where the visible buttons would stack into rows of their
 * own. Each item opens the same dialog the visible button does, with its
 * confirmation unchanged; AURA returns focus to ⋯ when it closes. The page
 * decides who gets it (same gates as the buttons).
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArchiveIcon, ShieldXIcon } from 'lucide-react';
import { DropdownMenu, IconButton, type MenuItem } from '@jirawatpyk/aura-react';
import { ArchiveMemberButton } from '@/components/members/archive-member-button';
import { EraseMemberButton } from '@/components/members/erase-member-button';

export function MemberHeaderMoreMenu({
  memberId,
  companyName,
  memberNumberDisplay,
  canArchive,
}: {
  readonly memberId: string;
  readonly companyName: string;
  readonly memberNumberDisplay: string;
  /** Archive only while the member is not archived. */
  readonly canArchive: boolean;
}) {
  const t = useTranslations('admin.members');
  const [eraseOpen, setEraseOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const label = t('detail.headerMoreActions');
  // The same lucide icons as the visible buttons (AURA's set has neither).
  const items: MenuItem[] = [
    { label: t('erase.eraseCta'), icon: <ShieldXIcon aria-hidden="true" />, tone: 'danger', onSelect: () => setEraseOpen(true) },
    ...(canArchive
      ? [{ label: t('archive.archiveCta'), icon: <ArchiveIcon aria-hidden="true" />, tone: 'danger' as const, onSelect: () => setArchiveOpen(true) }]
      : []),
  ];
  return (
    <span className="flex-none! sm:hidden">
      <DropdownMenu label={label} trigger={<IconButton icon="ellipsis" label={label} />} items={items} />
      <EraseMemberButton
        memberId={memberId}
        companyName={companyName}
        memberNumberDisplay={memberNumberDisplay}
        showTrigger={false}
        open={eraseOpen}
        onOpenChange={setEraseOpen}
      />
      {canArchive && (
        <ArchiveMemberButton
          memberId={memberId}
          companyName={companyName}
          showTrigger={false}
          open={archiveOpen}
          onOpenChange={setArchiveOpen}
        />
      )}
    </span>
  );
}
