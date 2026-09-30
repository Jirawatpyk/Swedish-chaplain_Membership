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
 * Names are stored in ENGLISH regardless of the admin's UI locale (reversed
 * from the original PR-B decision — see git history for the "store Thai"
 * version this replaced). Two independent facts settled it:
 *   - Legal: §86/4 วรรคสอง's Thai-language requirement is a DEFAULT, not an
 *     absolute bar. ประกาศอธิบดีกรมสรรพากร ฉบับที่ 92 (2542) pre-approves
 *     English-language + THB tax invoices automatically — no case-by-case
 *     Director-General application is needed (that approval path exists
 *     only for OTHER languages, or for foreign currency). TSCC's accountant
 *     independently confirmed the same: an English buyer name/address on a
 *     Thai tax invoice is fine, provided it is correct and verifiable.
 *   - Data: TSCC's existing member data is 100% English — of 150 members in
 *     the live spreadsheet, 132 have an address and not one contains a
 *     single Thai character. Storing Thai for newly-created members while
 *     the imported 132 stay English would make one chamber issue tax
 *     documents in two different languages, for no legal benefit.
 * `sub_district + city + province` are frozen onto the §86/4 tax document at
 * issue (compose-buyer-address.ts) — it is language-agnostic and prints
 * whatever is stored. The Thai name is shown only as the option's secondary `description`
 * inside the picker (see `dedupeOptions`) — a recognition aid for the admin,
 * never what gets saved. Do NOT revert this to Thai storage without new
 * evidence overturning both facts above.
 *
 * `LiveRegion` (SC 4.1.3 Status Messages) is mounted UNCONDITIONALLY with
 * empty content from the first render — its own docblock is explicit that a
 * conditionally-mounted live region is not announced by most screen readers.
 *
 * Autofill trade-off: `province`, `city` and `sub_district` are comboboxes
 * (AURA's `Combobox` sets `autocomplete="off"` on its input), so Chrome's
 * `address-level1`/`address-level2` autofill does not fill them. Only
 * `address_line1` / `address_line2` / `postal_code` carry working autofill —
 * the same trade-off Task 5 made for the country field; accepted, not
 * accidental.
 *
 * Typed values (review-round-2 Critical 1): a combobox with zero matching
 * options must not be a dead end. Of 955 postcodes, an unresolved/mistyped/
 * uncovered one is not rare, and blocking on it would make Thai member CREATE
 * impossible and imported members' addresses unfixable. The three comboboxes
 * pass AURA's `allowCustomValue` (5.16, handoff #105): Enter with nothing
 * highlighted, or leaving the field, keeps the typed text (text matching an
 * option's label picks that option). `postalCodeUnknownHint`'s promise of
 * manual entry depends on this.
 *
 * Spec 122 US5b-2 (T576): the board's Address card — the two lines across,
 * then postcode | province and district | sub-district from 640px, the
 * auto-filled note under them, the billing-address box after — on AURA fields,
 * with the Thai name as each option's `description`; the edit-mode
 * incomplete-address notice is an AURA warning alert.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { CircleCheckIcon } from 'lucide-react';
import { Alert, Button, Checkbox, Combobox, TextField, type ComboboxOption } from '@jirawatpyk/aura-react';
import { LiveRegion } from '@/components/shell/live-region';
import { CountryCombobox } from '@/components/members/country-combobox';
import { type MemberFormValues } from '../schema';
import { FormSectionCard } from '../form-section-card';

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

/** Dedupe candidate rows down to one option per distinct English name,
 * keeping the Thai name as the option's secondary `description` (searched too) (never the primary label
 * — the STORED value must stay the English name regardless of UI locale;
 * see the file-header comment for why). */
function dedupeOptions(
  candidates: readonly PostalCandidate[],
  pick: (c: PostalCandidate) => PostalName,
): ComboboxOption[] {
  const seen = new Map<string, ComboboxOption>();
  for (const c of candidates) {
    const name = pick(c);
    if (!name.en || seen.has(name.en)) continue;
    seen.set(name.en, { value: name.en, label: name.en, description: name.th });
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
  // member-billing-address (0284) — drives the reveal of the billing group.
  const billingDiffers = useWatch({ control, name: 'billing_differs' }) === true;

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
  // just-seeded key (`isMountRun = true` below) and a StrictMode replay
  // recomputes an IDENTICAL key (nothing in the deps actually changed
  // between the two invocations) — also `isMountRun = true`. Only a REAL
  // change (the admin edits the postcode, or `country` flips) produces a
  // different key, which updates the ref and flips `isMountRun` to `false`
  // from then on. The reset/clear paths still fire, because clearing the
  // field changes the key too.
  //
  // I1 fix (whole-branch review): `isMountRun` used to make the effect
  // `return` immediately — which skipped the FETCH, not just the write.
  // `candidates` then never populated on the Edit form, so the province/
  // district/sub-district pickers narrowed to nothing: for the ~132
  // imported TSCC members (`sub_district` is NULL on every one) the
  // sub-district combobox opened with ZERO options, forcing hand-typed
  // แขวง — exactly what committing the 367 KB postal dataset was meant to
  // avoid. The fetch (and `setCandidates`/`setLookupStatus`) must run on
  // every key, mount or not; only the WRITE side — `setValue`,
  // `setAutoFill`, `setAnnouncement` — is gated on `isMountRun`. That
  // preserves the anti-overwrite guarantee (nothing is silently written or
  // announced on load) while letting the option lists populate.
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
    // I1 fix: this used to `return` here, skipping the fetch entirely on
    // mount/StrictMode-replay. Now it only marks the run as a mount run —
    // the fetch still executes below; `isMountRun` instead gates the WRITE
    // side (setValue/setAutoFill/setAnnouncement) inside `run()`.
    const isMountRun = key === lastLookupKeyRef.current;
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
        // otherwise ride along on a non-TH member's submit. Skipped on a
        // mount run (I1) — a member loaded with country already ≠ TH must
        // not have its sub_district silently dirtied before the admin has
        // touched anything.
        if (!isMountRun) {
          setValue('sub_district', '', { shouldDirty: true });
        }
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
            if (!isMountRun) {
              setAnnouncement(tf('postalCodeUnknownAnnouncement', { code }));
            }
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

          const districts = new Set(found.map((c) => c.district.en));
          const first = found[0];

          if (districts.size === 1 && first) {
            // Unambiguous district (⇒ unambiguous province too — a district
            // belongs to exactly one province). Set province + district
            // always; additionally set sub-district only when IT is also
            // unique within that district (many single-district postcodes
            // still cover several sub-districts).
            //
            // I1 fix: on a mount run, `candidates` (set above,
            // unconditionally) is enough to narrow the option lists — the
            // WRITE side below (setValue × 3 / setAutoFill / setAnnouncement)
            // must NOT run, or loading the Edit form would silently
            // overwrite/dirty/announce a change the admin never made (the
            // exact Critical 2 bug the mount guard exists to prevent).
            const subDistricts = new Set(found.map((c) => c.subDistrict.en));
            const fillSub = subDistricts.size === 1;
            if (!isMountRun) {
              const previous = {
                province: getValues('province') ?? '',
                city: getValues('city') ?? '',
                subDistrict: getValues('sub_district') ?? '',
              };
              setValue('province', first.province.en, { shouldDirty: true });
              setValue('city', first.district.en, { shouldDirty: true });
              if (fillSub) {
                setValue('sub_district', first.subDistrict.en, { shouldDirty: true });
              }
              setAutoFill({
                code,
                filledSubDistrict: fillSub,
                previous,
                filled: {
                  province: first.province.en,
                  city: first.district.en,
                  subDistrict: fillSub ? first.subDistrict.en : null,
                },
              });
              setAnnouncement(
                fillSub
                  ? tf('postalCodeAutoFilledFull', { code })
                  : tf('postalCodeAutoFilledPartial', { code }),
              );
            }
            setLookupStatus('unambiguous');
          } else {
            // Ambiguous — set NOTHING. Narrow the option lists instead
            // (`candidates` is already set above, mount run or not).
            setAutoFill(null);
            setLookupStatus('ambiguous');
            if (!isMountRun) {
              const provinces = new Set(found.map((c) => c.province.en));
              setAnnouncement(
                provinces.size > 1
                  ? tf('postalCodeAmbiguousProvince', { code, count: provinces.size })
                  : tf('postalCodeAmbiguousDistrict', { code, count: districts.size }),
              );
            }
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
    return p ? candidates.filter((c) => c.province.en === p) : candidates;
  }, [candidates, provinceValue]);
  const cityOptions = useMemo(
    () => withCurrentValue(dedupeOptions(cityCandidates, (c) => c.district), cityValue),
    [cityCandidates, cityValue],
  );
  const subDistrictCandidates = useMemo(() => {
    const d = cityValue.trim();
    return d ? cityCandidates.filter((c) => c.district.en === d) : cityCandidates;
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
  // Bug fix (UAT 2026-07-15): the address is a §86/4 requirement of THAI
  // buyers only. A non-TH member's address is fully optional — no required
  // asterisk, no submit block (mirrors schema.ts's TH-gated completeness
  // superRefine). address_line1 is the one required marker shared by both
  // layouts, so it keys on this; the non-TH city/province/postal inputs below
  // carry no marker at all.
  const addressRequired = isCreate && countryIsTH;

  // The postcode's extra descriptions (the field's own hint is the SC 3.3.2
  // instruction; AURA replaces it with the error when there is one).
  const postalExtraDescribedBy =
    [
      lookupStatus === 'unknown' ? 'postal_code-unknown-hint' : null,
      activeAutoFill ? 'postal_code-autofill-hint' : null,
    ]
      .filter(Boolean)
      .join(' ') || undefined;

  return (
    <FormSectionCard id="address" title={t('sections.address')}>
      <div className="flex flex-col gap-4">
        {mode === 'edit' && addressIncomplete && (
          // A standing notice (`role="status"`): it shows on load and tracks
          // the fields as they change, so it must not interrupt as an alert.
          <Alert tone="warning" role="status" title={tf('addressIncompleteBanner')}>
            <a href="#address_line1" className="text-[var(--aura-fg-accent)] underline underline-offset-2">
              {tf('addressIncompleteJumpLink')}
            </a>
          </Alert>
        )}

        <TextField
          id="address_line1"
          label={tf('addressLine1')}
          required={addressRequired}
          aria-required={addressRequired}
          maxLength={200}
          autoComplete="address-line1"
          error={errors.address_line1?.message}
          {...register('address_line1')}
        />
        <TextField
          id="address_line2"
          label={tf('addressLine2')}
          maxLength={200}
          autoComplete="address-line2"
          error={errors.address_line2?.message}
          {...register('address_line2')}
        />

        {countryIsTH ? (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1">
                <TextField
                  id="postal_code"
                  label={tf('postalCode')}
                  required={isCreate}
                  aria-required={isCreate}
                  maxLength={20}
                  inputMode="numeric"
                  autoComplete="postal-code"
                  hint={tf('postalCodeInstruction')}
                  error={errors.postal_code?.message}
                  aria-describedby={postalExtraDescribedBy}
                  {...register('postal_code')}
                />
                {lookupStatus === 'unknown' && (
                  <p id="postal_code-unknown-hint" className="text-xs text-[var(--aura-fg-secondary)]">
                    {tf('postalCodeUnknownHint')}
                  </p>
                )}
              </div>
              <Controller
                control={control}
                name="province"
                render={({ field }) => (
                  <Combobox
                    id="province"
                    label={tf('province')}
                    required={isCreate}
                    options={provinceOptions}
                    value={field.value || null}
                    onChange={(next) => field.onChange(next ?? '')}
                    placeholder={tf('provincePlaceholder')}
                    emptyText={tf('provinceEmptyMessage')}
                    error={errors.province?.message}
                    // Review-round-2 Critical 1 fix: the postal dataset
                    // doesn't enumerate every Thai province spelling —
                    // manual entry must be a REAL escape hatch, matching
                    // `postalCodeUnknownHint`'s promise.
                    allowCustomValue
                  />
                )}
              />
              <Controller
                control={control}
                name="city"
                render={({ field }) => (
                  <Combobox
                    id="city"
                    label={tf('city')}
                    required={isCreate}
                    options={cityOptions}
                    value={field.value || null}
                    onChange={(next) => field.onChange(next ?? '')}
                    placeholder={tf('cityPlaceholder')}
                    emptyText={tf('cityEmptyMessage')}
                    error={errors.city?.message}
                    allowCustomValue
                  />
                )}
              />
              <Controller
                control={control}
                name="sub_district"
                render={({ field }) => (
                  <Combobox
                    id="sub_district"
                    label={tf('subDistrict')}
                    required={isCreate}
                    options={subDistrictOptions}
                    value={field.value || null}
                    onChange={(next) => field.onChange(next ?? '')}
                    placeholder={tf('subDistrictPlaceholder')}
                    emptyText={tf('subDistrictEmptyMessage')}
                    error={errors.sub_district?.message}
                    allowCustomValue
                  />
                )}
              />
            </div>
            {activeAutoFill && (
              <p
                id="postal_code-autofill-hint"
                className="-mt-2 flex flex-wrap items-center gap-x-2 text-xs text-[var(--aura-fg-secondary)]"
              >
                <CircleCheckIcon className="size-4 shrink-0" aria-hidden="true" />
                <span>{tf('postalCodeAutoFilledHint', { code: activeAutoFill.code })}</span>
                {/* 44px target (the project's bar; WCAG 2.5.8 wants ≥24),
                    pulled into the line so the note stays compact. */}
                <Button type="button" variant="ghost" size="sm" touchHeight className="-my-2" onClick={handleUndoAutoFill}>
                  {tf('postalCodeUndo')}
                </Button>
              </p>
            )}
          </>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {/* Non-TH: optional (no required marker) — a foreign member's
                address is not a §86/4 particular. Matches the TH-gated schema
                superRefine. */}
            <TextField
              id="city"
              label={tf('city')}
              maxLength={100}
              autoComplete="address-level2"
              error={errors.city?.message}
              {...register('city')}
            />
            <TextField
              id="province"
              label={tf('province')}
              maxLength={100}
              autoComplete="address-level1"
              error={errors.province?.message}
              {...register('province')}
            />
            <TextField
              id="postal_code"
              label={tf('postalCode')}
              maxLength={20}
              autoComplete="postal-code"
              error={errors.postal_code?.message}
              {...register('postal_code')}
            />
          </div>
        )}

        {/* member-billing-address (0284) — optional tax-document address.
            A checkbox reveals a SIMPLE 7-field group (plain fields + the
            shared CountryCombobox). Deliberately NO postal auto-fill /
            cascading-combobox machinery here: that apparatus above serves
            the operating address every member gets; the billing group is a
            rarer power-user field for VAT registrants whose ภ.พ.20 address
            differs — wiring a second lookup pipeline would double this
            file's most complex code for its least-used field (follow-up if
            demand appears). Unchecking HIDES the group but keeps the typed
            values in form state (re-checking restores them); the payload
            builders send the whole group as null while unchecked, which is
            what clears it server-side (no enable flag exists — "set" ⟺
            line1 IS NOT NULL). */}
        <Controller
          control={control}
          name="billing_differs"
          render={({ field }) => (
            <Checkbox
              id="billing_differs"
              name={field.name}
              ref={field.ref}
              onBlur={field.onBlur}
              checked={field.value === true}
              description={tf('billingDiffersHint')}
              onChange={(checked) => field.onChange(checked)}
            >
              {tf('billingDiffers')}
            </Checkbox>
          )}
        />
        {billingDiffers && (
          <div
            role="group"
            aria-labelledby="billing-address-heading"
            className="flex flex-col gap-4 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-canvas)] p-4"
          >
            <p id="billing-address-heading" className="text-sm font-semibold text-[var(--aura-fg-primary)]">
              {tf('billingAddressHeading')}
            </p>
            <TextField
              id="billing_address_line1"
              label={tf('addressLine1')}
              required
              aria-required="true"
              maxLength={200}
              error={errors.billing_address_line1?.message}
              {...register('billing_address_line1')}
            />
            <TextField
              id="billing_address_line2"
              label={tf('addressLine2')}
              maxLength={200}
              error={errors.billing_address_line2?.message}
              {...register('billing_address_line2')}
            />
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <TextField
                id="billing_sub_district"
                label={tf('subDistrict')}
                maxLength={100}
                error={errors.billing_sub_district?.message}
                {...register('billing_sub_district')}
              />
              <TextField
                id="billing_city"
                label={tf('city')}
                required
                aria-required="true"
                maxLength={100}
                error={errors.billing_city?.message}
                {...register('billing_city')}
              />
              <TextField
                id="billing_province"
                label={tf('province')}
                maxLength={100}
                error={errors.billing_province?.message}
                {...register('billing_province')}
              />
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <TextField
                id="billing_postal_code"
                label={tf('postalCode')}
                required
                aria-required="true"
                maxLength={20}
                error={errors.billing_postal_code?.message}
                {...register('billing_postal_code')}
              />
              <Controller
                control={control}
                name="billing_country"
                render={({ field }) => (
                  <CountryCombobox
                    id="billing_country"
                    label={tf('country')}
                    required
                    value={field.value ?? ''}
                    error={errors.billing_country?.message}
                    onChange={field.onChange}
                  />
                )}
              />
            </div>
          </div>
        )}

        {/* SC 4.1.3 — mounted unconditionally with empty content from the
            first render; a conditionally-mounted live region is not
            announced by most screen readers (see live-region.tsx docblock). */}
        <LiveRegion politeness="polite">{announcement}</LiveRegion>
      </div>
    </FormSectionCard>
  );
}
