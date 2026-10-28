'use client';

/**
 * T085 — Segment picker (4 RadioGroup options).
 *
 * Drives the `segment` field of the compose form:
 *   - all_members
 *   - tier:X (with tier code input)
 *   - event_attendees_last_90d
 *   - custom (paired with <CustomListInput />)
 *
 * The picker only emits the `kind` + `tierCodes` (when applicable).
 * `customRecipientEmails` is collected by the sibling <CustomListInput />.
 *
 * Spec 122 US12d-3 (T1270) — on AURA's RadioGroup (a fieldset named by its
 * legend, each radio by its own label; 44 px rows on touch).
 *
 * PR D (27 Oct 2026, FR-011): the tier option is a choice of the two
 * membership categories, more than one allowed. It used to be a free-text
 * "Tier code" field, but the recipient query matches only the `plan_category`
 * values, so anything else typed there reached nobody. PR G (28 Oct 2026):
 * the categories are AURA 5.67's CheckboxGroup (#183); since 5.68 its error
 * line announces itself (`errorLive`, #184).
 */
import { useLayoutEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckboxGroup, RadioGroup } from '@jirawatpyk/aura-react';
import { BROADCAST_TIER_CODES, type BroadcastTierCode } from '@/lib/broadcasts-tier-codes';

export type SegmentKind =
  | 'all_members'
  | 'tier'
  | 'event_attendees_last_90d'
  | 'custom';

export interface SegmentPickerValue {
  readonly kind: SegmentKind;
  /** Only categories can be held, so what is ticked is what is sent (/code-review). */
  readonly tierCodes: ReadonlyArray<BroadcastTierCode>;
}

export interface SegmentPickerProps {
  readonly value: SegmentPickerValue;
  readonly onChange: (next: SegmentPickerValue) => void;
  readonly disabled?: boolean;
  /**
   * Whether the categories' own error line is showing. The form shortens the
   * line by Submit while it does, so the sentence is not said twice.
   */
  readonly onTierErrorShownChange?: (shown: boolean) => void;
}

// The tier option is last (the maintainer, 27 Oct, PR D): its categories open
// below the whole list, so they sit right under the radio that opened them.
const OPTIONS: readonly SegmentKind[] = [
  'all_members',
  'event_attendees_last_90d',
  'custom',
  'tier',
];

function isSegmentKind(value: string): value is SegmentKind {
  return (OPTIONS as readonly string[]).includes(value);
}

export function SegmentPicker({
  value,
  onChange,
  disabled = false,
  onTierErrorShownChange,
}: SegmentPickerProps): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const tOption = useTranslations('portal.broadcasts.compose.segmentOption');

  return (
    <div className="space-y-3" data-compose-feature="segment-picker">
      <RadioGroup
        label={t('fields.segmentLabel')}
        options={OPTIONS.map((opt) => ({ value: opt, label: tOption(opt) }))}
        value={value.kind}
        onChange={(next) => {
          if (!isSegmentKind(next)) return;
          onChange({
            kind: next,
            tierCodes: next === 'tier' ? value.tierCodes : [],
          });
        }}
        disabled={disabled}
        touchHeight
      />
      {value.kind === 'tier' ? (
        <TierCategoriesField
          codes={value.tierCodes}
          onChange={(tierCodes) => onChange({ kind: 'tier', tierCodes })}
          disabled={disabled}
          onErrorShownChange={onTierErrorShownChange}
        />
      ) : null}
    </div>
  );
}

/** The categories, in a fixed order whatever order they were ticked in. */
function TierCategoriesField({
  codes,
  onChange,
  disabled,
  onErrorShownChange,
}: {
  readonly codes: ReadonlyArray<BroadcastTierCode>;
  readonly onChange: (codes: ReadonlyArray<BroadcastTierCode>) => void;
  readonly disabled: boolean;
  readonly onErrorShownChange: ((shown: boolean) => void) | undefined;
}): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const tCategory = useTranslations('portal.broadcasts.list.tierCode');
  // UX-C2: "none chosen" is said only once the member has unticked the last
  // one, not when the option first opens (enterprise UX review).
  const [touched, setTouched] = useState(false);
  const noneChosen = touched && codes.length === 0 ? t('submitBlocked.tierRequired') : null;
  const errorShown = noneChosen !== null;
  // Reported back so the line by Submit shortens rather than saying it again;
  // `false` on unmount, since leaving the tier option takes the line with it.
  // A layout effect, so the two never paint together for a frame. The latest
  // callback is read from a ref, so an inline one cannot re-run it each render.
  const report = useRef(onErrorShownChange);
  useLayoutEffect(() => {
    report.current = onErrorShownChange;
  });
  useLayoutEffect(() => {
    report.current?.(errorShown);
    return () => report.current?.(false);
  }, [errorShown]);
  return (
    <div data-compose-feature="tier-categories">
      <CheckboxGroup
        label={t('tierLabel')}
        hint={t('fields.tierCodesHelp')}
        error={noneChosen}
        errorLive
        required
        options={BROADCAST_TIER_CODES.map((code) => ({ value: code, label: tCategory(code) }))}
        value={[...codes]}
        onChange={(values) => {
          setTouched(true);
          onChange(BROADCAST_TIER_CODES.filter((code) => values.includes(code)));
        }}
        disabled={disabled}
        touchHeight
      />
    </div>
  );
}
