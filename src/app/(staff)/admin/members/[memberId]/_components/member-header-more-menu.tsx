'use client';

/**
 * The member header's ⋯ menu (layout B, maintainer 22 Oct; first on phones
 * only, 29 Sep): Archive and Erase sit here at every width, so the header
 * keeps Benefits and Edit beside it. Each item opens its own confirmation
 * dialog, unchanged; AURA returns focus to ⋯ when it closes. The page
 * decides who gets it; Erase, the most destructive, comes last.
 */
import { useRef, useState } from 'react';
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
  const moreRef = useRef<HTMLButtonElement>(null);
  const label = t('detail.headerMoreActions');
  // The same lucide icons as the visible buttons (AURA's set has neither).
  const items: MenuItem[] = [
    ...(canArchive
      ? [{ label: t('archive.archiveCta'), icon: <ArchiveIcon aria-hidden="true" />, tone: 'danger' as const, onSelect: () => setArchiveOpen(true) }]
      : []),
    // Erase cannot be undone (Archive can, within its window): set apart.
    ...(canArchive ? [{ separator: true as const }] : []),
    { label: t('erase.eraseCta'), icon: <ShieldXIcon aria-hidden="true" />, tone: 'danger', onSelect: () => setEraseOpen(true) },
  ];
  return (
    <span className="flex-none!">
      <DropdownMenu label={label} trigger={<IconButton ref={moreRef} icon="ellipsis" label={label} touchHeight />} items={items} />
      <EraseMemberButton
        memberId={memberId}
        companyName={companyName}
        memberNumberDisplay={memberNumberDisplay}
        showTrigger={false}
        open={eraseOpen}
        onOpenChange={setEraseOpen}
        finalFocus={moreRef}
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
