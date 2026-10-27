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
 * legend, each radio by its own label; 44 px rows on touch) and TextField.
 * The tier-codes field keeps the typed TEXT and derives the codes from it: it
 * used to be controlled by `tierCodes.join(', ')`, which split the comma away
 * as it was typed, so a second code could never be entered.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { RadioGroup, TextField } from '@jirawatpyk/aura-react';

export type SegmentKind =
  | 'all_members'
  | 'tier'
  | 'event_attendees_last_90d'
  | 'custom';

export interface SegmentPickerValue {
  readonly kind: SegmentKind;
  readonly tierCodes: ReadonlyArray<string>;
}

export interface SegmentPickerProps {
  readonly value: SegmentPickerValue;
  readonly onChange: (next: SegmentPickerValue) => void;
  readonly disabled?: boolean;
}

const OPTIONS: readonly SegmentKind[] = [
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
];

function isSegmentKind(value: string): value is SegmentKind {
  return (OPTIONS as readonly string[]).includes(value);
}

function parseTierCodes(raw: string): ReadonlyArray<string> {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function SegmentPicker({
  value,
  onChange,
  disabled = false,
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
        <TierCodesField
          initialCodes={value.tierCodes}
          onChange={(tierCodes) => onChange({ kind: 'tier', tierCodes })}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

/**
 * Mounted only while the tier option is chosen, so its text starts from the
 * codes already held and is never overwritten by their re-joined form.
 */
function TierCodesField({
  initialCodes,
  onChange,
  disabled,
}: {
  readonly initialCodes: ReadonlyArray<string>;
  readonly onChange: (codes: ReadonlyArray<string>) => void;
  readonly disabled: boolean;
}): React.ReactElement {
  const t = useTranslations('portal.broadcasts.compose');
  const [text, setText] = useState(() => initialCodes.join(', '));
  return (
    <TextField
      id="segment-tier-codes"
      className="ml-6 sm:max-w-sm"
      label={t('tierLabel')}
      hint={t('fields.tierCodesHelp')}
      value={text}
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseTierCodes(e.target.value));
      }}
      placeholder={t('fields.tierCodesPlaceholder')}
      disabled={disabled}
      touchHeight
    />
  );
}
