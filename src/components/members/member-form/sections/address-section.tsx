'use client';

/**
 * MemberForm — Address section (PR-B task 6).
 *
 * The postcode FILTERS; it never overwrites. Of 955 Thai postal codes, 781
 * map to one district, 144 to two, 26 to three, 4 to four — and 8 span two
 * provinces (13240 = Ayutthaya/Lopburi). An autofill that GUESSES is wrong
 * by construction, so:
 *   - Unambiguous (single district AND single sub-district) → the values
 *     are SET, an "auto-filled" hint with an Undo appears, and a
 *     `LiveRegion` announces it.
 *   - Ambiguous at any level (multiple districts, or multiple provinces) →
 *     NOTHING is set. The affected combobox's options narrow to the
 *     candidates and the live region announces the count. Picking a
 *     district further narrows the sub-district options to that district's.
 *   - Unknown code (404) → nothing is set, no block, a hint invites manual
 *     entry.
 *
 * Province, district (`city`) and sub-district are always the SAME editable
 * `Combobox` — never swapped for a plain/read-only/`<Select>` variant
 * depending on the lookup. Swapping widgets mid-keystroke destroys focus on
 * remount, breaks pasting a whole address block (the postcode handler would
 * clobber what was just pasted), kills Chrome's `autoComplete="address-
 * level1"/"address-level2"/"postal-code"` autofill, and trips WCAG SC 3.2.2
 * (On Input). Because the 97 KB postal dataset is server-only
 * (`src/lib/thai-postal/lookup.ts` is `import 'server-only'` — it CANNOT be
 * imported here), there is no client-side "full list" of provinces/
 * districts/sub-districts to seed these comboboxes with before a postcode
 * lookup runs; `withCurrentValue` below guarantees the admin's own typed/
 * seeded value is never silently hidden by an empty or narrowed option list.
 *
 * Names are stored in THAI regardless of the admin's UI locale — `sub_district
 * + city + province` are frozen onto the §86/4 tax document at issue
 * (compose-buyer-address.ts), and RC §86/4 วรรคสอง requires Thai particulars.
 * The English name is shown only as secondary `detail` text inside the
 * picker (see `dedupeOptions`).
 *
 * `LiveRegion` (SC 4.1.3 Status Messages) is mounted UNCONDITIONALLY with
 * empty content from the first render — its own docblock is explicit that a
 * conditionally-mounted live region is not announced by most screen readers.
 *
 * Trade-off, NOT "preserved verbatim" (review-round-2 correction — the first
 * implementation report claimed `autoComplete` was preserved verbatim on
 * every field; that was wrong for these three): `province`, `city` and
 * `sub_district` are each a button-based `Combobox` (`role="combobox"`, not
 * an `<input>`), so Chrome's `autoComplete="address-level1"/"address-
 * level2"` autofill CANNOT act on them — a `<button>` is never an autofill
 * target, independent of anything the lookup effect does. Only
 * `address_line1` / `address_line2` / `postal_code` (still plain `<Input>`s)
 * carry working autofill. This is the same trade-off Task 5 already made for
 * the country field; it is accepted, not accidental — but it must be
 * documented honestly, not asserted away.
 *
 * `allowCustomValue` (review-round-2 Critical 1 fix): a `Combobox` with zero
 * matching options is otherwise a dead end — the trigger is a `<button>`,
 * there is no way to type a value the option list doesn't already contain.
 * Of 955 postcodes, an unresolved/mistyped/uncovered one is not rare, and
 * blocking on it would make Thai member CREATE impossible and imported
 * members' addresses unfixable. `province`/`city`/`sub_district` therefore
 * pass `allowCustomValue` + a translated `customValueLabel` — see
 * `ui/combobox.tsx`'s file-header comment for how the "Use «text»" item
 * itself works. `postalCodeUnknownHint`'s promise of manual entry depends on
 * this being wired.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { AlertTriangleIcon } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { RequiredMark } from '@/components/ui/required-mark';
import { LiveRegion } from '@/components/ui/live-region';
import { Combobox, type ComboboxOption } from '@/components/ui/combobox';
import { FieldError } from '../field-error';
import { type MemberFormValues } from '../schema';

const POSTAL_CODE_RE = /^\d{5}$/;
const LOOKUP_DEBOUNCE_MS = 300;

type PostalName = { readonly th: string; readonly en: string };
type PostalCandidate = {
  readonly subDistrict: PostalName;
  readonly district: PostalName;
  readonly province: PostalName;
};

type LookupStatus = 'idle' | 'loading' | 'unambiguous' | 'ambiguous' | 'unknown' | 'error';

type AutoFillSnapshot = {
  readonly code: string;
  readonly filledSubDistrict: boolean;
  readonly previous: {
    readonly province: string;
    readonly city: string;
    readonly subDistrict: string;
  };
  // What the auto-fill itself SET, so a later manual edit can be detected
  // (see `autoFillStale` below) — Undo must never silently discard a manual
  // correction the admin made after the auto-fill fired.
  readonly filled: {
    readonly province: string;
    readonly city: string;
    readonly subDistrict: string | null;
  };
};

/** Dedupe candidate rows down to one option per distinct Thai name, keeping
 * the English name as secondary `detail` text (never the primary label —
 * the STORED value must stay the Thai name regardless of UI locale). */
function dedupeOptions(
  candidates: readonly PostalCandidate[],
  pick: (c: PostalCandidate) => PostalName,
): ComboboxOption[] {
  const seen = new Map<string, ComboboxOption>();
  for (const c of candidates) {
    const name = pick(c);
    if (!name.th || seen.has(name.th)) continue;
    seen.set(name.th, { value: name.th, label: name.th, detail: name.en });
  }
  return Array.from(seen.values());
}

/** Guarantees the admin's own current value is never silently hidden by an
 * empty/narrowed option list — before any postcode lookup (or on an
 * existing/imported member's value) there is no known candidate list, and
 * `Combobox` only shows a value that is present in `options`. */
function withCurrentValue(options: ComboboxOption[], current: string): ComboboxOption[] {
  const trimmed = current.trim();
  if (!trimmed || options.some((o) => o.value === trimmed)) return options;
  return [{ value: trimmed, label: trimmed }, ...options];
}

export function AddressSection({ mode }: { readonly mode: 'create' | 'edit' }) {
  const t = useTranslations('admin.members.create');
  const tf = useTranslations('admin.members.create.fields');
  const {
    register,
    control,
    getValues,
    setValue,
    formState: { errors },
  } = useFormContext<MemberFormValues>();

  // NOTE: deliberately no `defaultValue` on any of these `useWatch` calls.
  // RHF treats a `useWatch` `defaultValue` as a FIRST-RENDER OVERRIDE, not a
  // fallback for "unset" — passing one here would show 'TH' on first paint
  // even when `defaultValues.country` was seeded as e.g. 'SE' from
  // `initialValues` (edit mode), and never self-correct without a later
  // interaction. Fall back with `?? ''` / `?? 'TH'` on the RETURNED value
  // instead, same pattern as company-section.tsx's `getValues('country') ??
  // 'TH'` seed.
  const country = useWatch({ control, name: 'country' }) ?? 'TH';
  const countryIsTH = country.toUpperCase() === 'TH';

  const postalCodeValue = useWatch({ control, name: 'postal_code' }) ?? '';
  const cityValue = useWatch({ control, name: 'city' }) ?? '';
  const provinceValue = useWatch({ control, name: 'province' }) ?? '';
  const subDistrictValue = useWatch({ control, name: 'sub_district' }) ?? '';
  const addressLine1Value = useWatch({ control, name: 'address_line1' }) ?? '';

  const [candidates, setCandidates] = useState<readonly PostalCandidate[]>([]);
  const [lookupStatus, setLookupStatus] = useState<LookupStatus>('idle');
  const [announcement, setAnnouncement] = useState('');
  const [autoFill, setAutoFill] = useState<AutoFillSnapshot | null>(null);

  // Review-round-2 Critical 2 fix: `postalCodeValue`/`countryIsTH` from
  // `useWatch` (no `defaultValue`, per the comment above) read RHF's
  // `defaultValues` on the very FIRST render — in edit mode that is the
  // member's already-SAVED postcode, not something the admin just typed.
  // Without a guard, the effect below fires ~300ms after every edit-form
  // load, and for any unambiguous saved postcode (≈82% of them) silently
  // overwrites province/city/sub_district with "auto-filled" values, marks
  // them dirty, and announces a change the admin never made — the exact
  // failure this whole feature exists to prevent, on its most common
  // non-create interaction.
  //
  // a11y re-review fix: the original guard here was a plain
  // `hasMountedRef = useRef(false)` flipped to `true` on the effect's first
  // invocation, with no cleanup. That guard is NOT StrictMode-safe, and
  // this is a LIVE bug, not "dev-only console noise" — `next.config.ts`'s
  // `reactStrictMode: true` replays every effect once on mount (setup →
  // cleanup → setup again), including in dev, and **UAT runs against the
  // dev server on :3100**. The boolean flips `true` on the replay's FIRST
  // setup; its SECOND setup then sees `hasMountedRef.current` already
  // `true` and runs the full lookup body against the mount-time value —
  // on the dev server that IS the Critical 2 bug happening again (a real
  // `setValue` + dirty flags + live-region announcement a tester will see
  // and report), not noise. (Production is genuinely unaffected — React
  // never double-invokes effects outside dev — so this was never a
  // data-corruption risk in prod, only a dev/UAT-visible one.)
  //
  // A cleanup-based fix (reset the ref back to `false` in the effect's own
  // cleanup) was tried and reverted: React runs the PREVIOUS invocation's
  // cleanup before EVERY next invocation, not just the StrictMode replay
  // one — so the reset re-arms the skip on the admin's very first genuine
  // keystroke too, permanently breaking the lookup.
  //
  // Fix: key on the *value* instead of "have I run yet". `lastLookupKeyRef`
  // is seeded once during render (`??=` — a no-op on every render after the
  // first, including StrictMode's double-render) with the mount-time
  // `countryIsTH|postalCode` pair. The effect recomputes the same key on
  // every invocation and compares: the initial setup sees its own
  // just-seeded key and skips (no cleanup scheduled); a StrictMode replay
  // recomputes an IDENTICAL key (nothing in the deps actually changed
  // between the two invocations) and also skips — idempotent, no
  // cleanup-based reset needed. Only a REAL change (the admin edits the
  // postcode, or `country` flips) produces a different key, which updates
  // the ref and lets the body run. The reset/clear paths still fire,
  // because clearing the field changes the key too.
  const lastLookupKeyRef = useRef<string | null>(null);
  lastLookupKeyRef.current ??= `${countryIsTH}|${postalCodeValue.trim()}`;

  // Debounced postcode → candidates lookup, PLUS the country-switch-away/
  // malformed-code reset. All of it is routed through the scheduled
  // `setTimeout` callback below (never a bare synchronous `setState` in the
  // effect body) — React's `set-state-in-effect` rule flags the latter as a
  // cascading-render anti-pattern; a callback (timer or async) is the
  // documented escape hatch ("subscribe for updates ... calling setState in
  // a callback function"). A 300ms delay on the reset path is imperceptible
  // (it is a state cleanup, not something the admin is waiting to see).
  useEffect(() => {
    const key = `${countryIsTH}|${postalCodeValue.trim()}`;
    if (key === lastLookupKeyRef.current) return; // mount value, or a no-op replay
    lastLookupKeyRef.current = key;

    let cancelled = false;
    const controller = new AbortController();

    const run = () => {
      if (!countryIsTH) {
        setCandidates([]);
        setLookupStatus('idle');
        setAutoFill(null);
        // Important 3 fix: the sub-district FIELD unmounts in the non-TH
        // branch below, but the form VALUE it held survives unless cleared
        // here — `create-member-client.tsx`'s `toPayload` forwards
        // `sub_district` unconditionally, so a stale Thai sub-district would
        // otherwise ride along on a non-TH member's submit.
        setValue('sub_district', '', { shouldDirty: true });
        return;
      }
      const code = postalCodeValue.trim();
      if (!POSTAL_CODE_RE.test(code)) {
        setCandidates([]);
        setLookupStatus('idle');
        return;
      }

      void (async () => {
        setLookupStatus('loading');
        try {
          const res = await fetch(`/api/geo/postal/${code}`, {
            method: 'GET',
            signal: controller.signal,
            headers: { Accept: 'application/json' },
          });
          if (cancelled) return;

          if (res.status === 404) {
            setCandidates([]);
            setLookupStatus('unknown');
            setAnnouncement(tf('postalCodeUnknownAnnouncement', { code }));
            return;
          }
          if (!res.ok) {
            setCandidates([]);
            setLookupStatus('error');
            return;
          }

          const body = (await res.json()) as { candidates?: PostalCandidate[] };
          const found = body.candidates ?? [];
          if (cancelled) return;
          setCandidates(found);

          const districts = new Set(found.map((c) => c.district.th));
          const first = found[0];

          if (districts.size === 1 && first) {
            // Unambiguous district (⇒ unambiguous province too — a district
            // belongs to exactly one province). Set province + district
            // always; additionally set sub-district only when IT is also
            // unique within that district (many single-district postcodes
            // still cover several sub-districts).
            const subDistricts = new Set(found.map((c) => c.subDistrict.th));
            const fillSub = subDistricts.size === 1;
            const previous = {
              province: getValues('province') ?? '',
              city: getValues('city') ?? '',
              subDistrict: getValues('sub_district') ?? '',
            };
            setValue('province', first.province.th, { shouldDirty: true });
            setValue('city', first.district.th, { shouldDirty: true });
            if (fillSub) {
              setValue('sub_district', first.subDistrict.th, { shouldDirty: true });
            }
            setAutoFill({
              code,
              filledSubDistrict: fillSub,
              previous,
              filled: {
                province: first.province.th,
                city: first.district.th,
                subDistrict: fillSub ? first.subDistrict.th : null,
              },
            });
            setLookupStatus('unambiguous');
            setAnnouncement(
              fillSub
                ? tf('postalCodeAutoFilledFull', { code })
                : tf('postalCodeAutoFilledPartial', { code }),
            );
          } else {
            // Ambiguous — set NOTHING. Narrow the option lists instead.
            setAutoFill(null);
            setLookupStatus('ambiguous');
            const provinces = new Set(found.map((c) => c.province.th));
            setAnnouncement(
              provinces.size > 1
                ? tf('postalCodeAmbiguousProvince', { code, count: provinces.size })
                : tf('postalCodeAmbiguousDistrict', { code, count: districts.size }),
            );
          }
        } catch (e) {
          if (!cancelled && !(e instanceof DOMException && e.name === 'AbortError')) {
            setCandidates([]);
            setLookupStatus('error');
          }
        }
      })();
    };

    const handle = setTimeout(run, LOOKUP_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(handle);
    };
    // `tf` deliberately excluded — including it would re-run (and re-debounce)
    // this effect on every locale-context re-render, not just postcode/country
    // edits. Same convention as member-picker.tsx's fetch effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postalCodeValue, countryIsTH, getValues, setValue]);

  const handleUndoAutoFill = useCallback(() => {
    if (!autoFill) return;
    setValue('province', autoFill.previous.province, { shouldDirty: true });
    setValue('city', autoFill.previous.city, { shouldDirty: true });
    if (autoFill.filledSubDistrict) {
      setValue('sub_district', autoFill.previous.subDistrict, { shouldDirty: true });
    }
    setAutoFill(null);
    setLookupStatus('idle');
    setAnnouncement(tf('postalCodeAutoFillUndone'));
  }, [autoFill, setValue, tf]);

  // Cascading option lists: province ← full candidate set; city (district)
  // ← candidates matching the chosen province (if any); sub-district ←
  // candidates matching the chosen district (if any). Each is unioned with
  // the admin's own current value so it is never silently hidden.
  const provinceOptions = useMemo(
    () => withCurrentValue(dedupeOptions(candidates, (c) => c.province), provinceValue),
    [candidates, provinceValue],
  );
  const cityCandidates = useMemo(() => {
    const p = provinceValue.trim();
    return p ? candidates.filter((c) => c.province.th === p) : candidates;
  }, [candidates, provinceValue]);
  const cityOptions = useMemo(
    () => withCurrentValue(dedupeOptions(cityCandidates, (c) => c.district), cityValue),
    [cityCandidates, cityValue],
  );
  const subDistrictCandidates = useMemo(() => {
    const d = cityValue.trim();
    return d ? cityCandidates.filter((c) => c.district.th === d) : cityCandidates;
  }, [cityCandidates, cityValue]);
  const subDistrictOptions = useMemo(
    () =>
      withCurrentValue(dedupeOptions(subDistrictCandidates, (c) => c.subDistrict), subDistrictValue),
    [subDistrictCandidates, subDistrictValue],
  );

  // Undo must never silently discard a manual correction the admin made
  // AFTER the auto-fill fired — if province/city/(sub-district, when the
  // auto-fill set it) no longer match what the auto-fill itself wrote, OR
  // the admin has since edited the postcode away from the code the hint
  // refers to, the hint + Undo affordance are stale and hidden (derived at
  // render time, no effect needed).
  const autoFillStale = useMemo(() => {
    if (!autoFill) return false;
    if (postalCodeValue.trim() !== autoFill.code) return true;
    if (provinceValue !== autoFill.filled.province) return true;
    if (cityValue !== autoFill.filled.city) return true;
    if (autoFill.filled.subDistrict !== null && subDistrictValue !== autoFill.filled.subDistrict) {
      return true;
    }
    return false;
  }, [autoFill, postalCodeValue, provinceValue, cityValue, subDistrictValue]);
  const activeAutoFill = autoFill && !autoFillStale ? autoFill : null;

  // Edit-mode completeness banner (create blocks via the schema instead —
  // see schema.ts's superRefine). Computed live from the watched values so
  // it updates as the admin edits, independent of any submit attempt.
  const addressIncomplete = useMemo(() => {
    if (!addressLine1Value.trim() || !cityValue.trim()) return true;
    if (countryIsTH) {
      return !provinceValue.trim() || !subDistrictValue.trim() || !postalCodeValue.trim();
    }
    return false;
  }, [addressLine1Value, cityValue, countryIsTH, provinceValue, subDistrictValue, postalCodeValue]);

  const isCreate = mode === 'create';

  return (
    <fieldset className="flex flex-col gap-4 rounded-md border p-4">
      <legend className="px-2 text-base font-semibold">{t('sections.address')}</legend>

      {mode === 'edit' && addressIncomplete && (
        <div className="flex items-start gap-2 rounded-md border border-amber-600/40 bg-amber-50 p-3 text-sm dark:border-amber-400/40 dark:bg-amber-950/30">
          <AlertTriangleIcon
            className="mt-0.5 size-4 shrink-0 text-amber-700 dark:text-amber-400"
            aria-hidden="true"
          />
          <p className="text-amber-800 dark:text-amber-200">
            {tf('addressIncompleteBanner')}{' '}
            <a href="#address_line1" className="underline underline-offset-2">
              {tf('addressIncompleteJumpLink')}
            </a>
          </p>
        </div>
      )}

      <div>
        <Label htmlFor="address_line1">
          {tf('addressLine1')}
          {isCreate && <RequiredMark />}
        </Label>
        <Input
          id="address_line1"
          {...register('address_line1')}
          maxLength={200}
          autoComplete="address-line1"
          required={isCreate}
          aria-required={isCreate}
          aria-invalid={Boolean(errors.address_line1)}
          aria-describedby={errors.address_line1 ? 'address_line1-error' : undefined}
        />
        <FieldError id="address_line1-error" message={errors.address_line1?.message} />
      </div>
      <div>
        <Label htmlFor="address_line2">{tf('addressLine2')}</Label>
        <Input
          id="address_line2"
          {...register('address_line2')}
          maxLength={200}
          autoComplete="address-line2"
          aria-invalid={Boolean(errors.address_line2)}
          aria-describedby={errors.address_line2 ? 'address_line2-error' : undefined}
        />
        <FieldError id="address_line2-error" message={errors.address_line2?.message} />
      </div>

      {countryIsTH ? (
        <>
          <div>
            <Label htmlFor="postal_code">
              {tf('postalCode')}
              {isCreate && <RequiredMark />}
            </Label>
            <Input
              id="postal_code"
              {...register('postal_code')}
              maxLength={20}
              inputMode="numeric"
              autoComplete="postal-code"
              required={isCreate}
              aria-required={isCreate}
              aria-invalid={Boolean(errors.postal_code)}
              aria-describedby={
                [
                  errors.postal_code ? 'postal_code-error' : null,
                  'postal_code-instruction',
                  lookupStatus === 'unknown' ? 'postal_code-unknown-hint' : null,
                  activeAutoFill ? 'postal_code-autofill-hint' : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
            <p id="postal_code-instruction" className="mt-1 text-xs text-muted-foreground">
              {tf('postalCodeInstruction')}
            </p>
            {lookupStatus === 'unknown' && (
              <p id="postal_code-unknown-hint" className="mt-1 text-xs text-muted-foreground">
                {tf('postalCodeUnknownHint')}
              </p>
            )}
            {activeAutoFill && (
              <p
                id="postal_code-autofill-hint"
                className="mt-1 flex items-center gap-2 text-xs text-muted-foreground"
              >
                <span>{tf('postalCodeAutoFilledHint', { code: activeAutoFill.code })}</span>
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  // Review-round-2 Important 4 fix: `h-auto p-0` collapsed the
                  // hit area to the 12px text's own line-height (WCAG 2.5.8
                  // wants ≥24×24, this project's bar is 44×44). `min-h-11`
                  // restores the tap target; `-mx-2 px-2` keeps the visible
                  // chrome compact without shifting the surrounding text
                  // horizontally (same pattern as copy-charge-id-button.tsx).
                  className="h-auto min-h-11 -mx-2 px-2 text-xs"
                  onClick={handleUndoAutoFill}
                >
                  {tf('postalCodeUndo')}
                </Button>
              </p>
            )}
            <FieldError id="postal_code-error" message={errors.postal_code?.message} />
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <Label id="province-label" htmlFor="province">
                {tf('province')}
                {isCreate && <RequiredMark />}
              </Label>
              <Controller
                control={control}
                name="province"
                render={({ field }) => (
                  <Combobox
                    id="province"
                    options={provinceOptions}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    placeholder={tf('provincePlaceholder')}
                    searchPlaceholder={tf('provinceSearchPlaceholder')}
                    emptyMessage={tf('provinceEmptyMessage')}
                    aria-labelledby="province-label"
                    aria-required={isCreate}
                    aria-invalid={Boolean(errors.province)}
                    aria-describedby={errors.province ? 'province-error' : undefined}
                    // Review-round-2 Critical 1 fix: the 97 KB postal dataset
                    // doesn't enumerate every Thai province spelling/typo —
                    // manual entry must be a REAL escape hatch, matching
                    // `postalCodeUnknownHint`'s promise below.
                    allowCustomValue
                    customValueLabel={(typed) => tf('useTypedValueLabel', { value: typed })}
                  />
                )}
              />
              <FieldError id="province-error" message={errors.province?.message} />
            </div>
            <div>
              <Label id="city-label" htmlFor="city">
                {tf('city')}
                {isCreate && <RequiredMark />}
              </Label>
              <Controller
                control={control}
                name="city"
                render={({ field }) => (
                  <Combobox
                    id="city"
                    options={cityOptions}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    placeholder={tf('cityPlaceholder')}
                    searchPlaceholder={tf('citySearchPlaceholder')}
                    emptyMessage={tf('cityEmptyMessage')}
                    aria-labelledby="city-label"
                    aria-required={isCreate}
                    aria-invalid={Boolean(errors.city)}
                    aria-describedby={errors.city ? 'city-error' : undefined}
                    allowCustomValue
                    customValueLabel={(typed) => tf('useTypedValueLabel', { value: typed })}
                  />
                )}
              />
              <FieldError id="city-error" message={errors.city?.message} />
            </div>
            <div>
              <Label id="sub_district-label" htmlFor="sub_district">
                {tf('subDistrict')}
                {isCreate && <RequiredMark />}
              </Label>
              <Controller
                control={control}
                name="sub_district"
                render={({ field }) => (
                  <Combobox
                    id="sub_district"
                    options={subDistrictOptions}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    placeholder={tf('subDistrictPlaceholder')}
                    searchPlaceholder={tf('subDistrictSearchPlaceholder')}
                    emptyMessage={tf('subDistrictEmptyMessage')}
                    aria-labelledby="sub_district-label"
                    aria-required={isCreate}
                    aria-invalid={Boolean(errors.sub_district)}
                    aria-describedby={errors.sub_district ? 'sub_district-error' : undefined}
                    allowCustomValue
                    customValueLabel={(typed) => tf('useTypedValueLabel', { value: typed })}
                  />
                )}
              />
              <FieldError id="sub_district-error" message={errors.sub_district?.message} />
            </div>
          </div>
        </>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          <div>
            <Label htmlFor="city">
              {tf('city')}
              {isCreate && <RequiredMark />}
            </Label>
            <Input
              id="city"
              {...register('city')}
              maxLength={100}
              autoComplete="address-level2"
              required={isCreate}
              aria-required={isCreate}
              aria-invalid={Boolean(errors.city)}
              aria-describedby={errors.city ? 'city-error' : undefined}
            />
            <FieldError id="city-error" message={errors.city?.message} />
          </div>
          <div>
            <Label htmlFor="province">{tf('province')}</Label>
            <Input
              id="province"
              {...register('province')}
              maxLength={100}
              autoComplete="address-level1"
              aria-invalid={Boolean(errors.province)}
              aria-describedby={errors.province ? 'province-error' : undefined}
            />
            <FieldError id="province-error" message={errors.province?.message} />
          </div>
          <div>
            <Label htmlFor="postal_code">{tf('postalCode')}</Label>
            <Input
              id="postal_code"
              {...register('postal_code')}
              maxLength={20}
              autoComplete="postal-code"
              aria-invalid={Boolean(errors.postal_code)}
              aria-describedby={errors.postal_code ? 'postal_code-error' : undefined}
            />
            <FieldError id="postal_code-error" message={errors.postal_code?.message} />
          </div>
        </div>
      )}

      {/* SC 4.1.3 — mounted unconditionally with empty content from the
          first render; a conditionally-mounted live region is not
          announced by most screen readers (see live-region.tsx docblock). */}
      <LiveRegion politeness="polite">{announcement}</LiveRegion>
    </fieldset>
  );
}
