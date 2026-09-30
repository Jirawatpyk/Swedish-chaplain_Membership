/**
 * The pipeline help: a tap-discoverable "About the renewal pipeline" popover
 * (what the pipeline lists, and what Suspended and Terminated mean). A
 * popover, not a hover tooltip, so it works on touch.
 *
 * 122 US7a (T703): AURA `Popover` behind an info `IconButton`, at the end of
 * the All renewals / Needs action row, where the `Admin-renewals` board draws
 * it.
 */
'use client';

import { useTranslations } from 'next-intl';
import { IconButton, Popover } from '@jirawatpyk/aura-react';

export function PipelineHelp() {
  const t = useTranslations('admin.renewals.pipelineHelp');
  return (
    <Popover
      title={t('title')}
      placement="bottom-end"
      width={320}
      trigger={<IconButton icon="info" label={t('ariaLabel')} size="sm" />}
    >
      <div className="flex flex-col gap-[var(--aura-space-2)] text-[var(--aura-fg-secondary)]">
        <p>{t('body')}</p>
        <dl className="flex flex-col gap-[var(--aura-space-2)]">
          <div>
            <dt className="font-medium text-[var(--aura-fg-primary)]">{t('suspendedTerm')}</dt>
            <dd>{t('suspendedDef')}</dd>
          </div>
          <div>
            <dt className="font-medium text-[var(--aura-fg-primary)]">{t('terminatedTerm')}</dt>
            <dd>{t('terminatedDef')}</dd>
          </div>
        </dl>
      </div>
    </Popover>
  );
}
