'use client';

/**
 * F119 T145 (FR-039) — the subject character counter, shared by the member
 * compose form and the staff compose-on-behalf form so the two can never
 * disagree about the limit or the wording. The staff form deliberately reuses
 * the member `portal.broadcasts.compose.*` copy, as it already does for the
 * segment, schedule and submit controls.
 */
import { useTranslations } from 'next-intl';

export const SUBJECT_MAX_LENGTH = 200;

export interface SubjectCounterProps {
  /** The id the subject input points at via `aria-describedby`. */
  readonly id: string;
  readonly value: string;
}

export function SubjectCounter({
  id,
  value,
}: SubjectCounterProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose.fields');
  return (
    // aria-live off: the count changes on every keystroke; announcing it would
    // drown out everything else the user is doing.
    <p id={id} className="text-xs text-muted-foreground" aria-live="off">
      {t('subjectCounter', { count: value.length, max: SUBJECT_MAX_LENGTH })}
    </p>
  );
}
