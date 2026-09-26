'use client';

/**
 * What an auth form's `FormErrorSummary` lists: the errors of the LAST submit,
 * not react-hook-form's live `errors` (spec 122 US2).
 *
 * After a failed submit RHF re-validates on every change, so the live object
 * empties and refills while the user types, and AURA's summary takes focus
 * each time it goes from empty to non-empty: it would pull focus out of the
 * field being typed in (WCAG 3.2.2). A snapshot only changes on submit; like
 * GOV.UK's summary it stays until the next one, and the per-field messages
 * stay live on the fields.
 */
import { useCallback, useState } from 'react';
import type { FieldErrors, FieldValues, Path } from 'react-hook-form';

export interface SubmittedErrors<T extends FieldValues> {
  /** Pass to `FormErrorSummary errors`. */
  readonly errors: FieldErrors<T>;
  /** Pass as `handleSubmit`'s second argument (client validation failed). */
  readonly onInvalid: (errors: FieldErrors<T>) => void;
  /** Call when a submit passes validation, before the request. */
  readonly clear: () => void;
  /** A server rejection that belongs to one field (set it on the field too). */
  readonly show: (field: Path<T>, message: string) => void;
}

export function useSubmittedErrors<T extends FieldValues>(): SubmittedErrors<T> {
  const [errors, setErrors] = useState<FieldErrors<T>>({});
  const onInvalid = useCallback((next: FieldErrors<T>) => {
    // `root` is a form-level server message with its own alert, never a field.
    const { root: _root, ...fields } = next;
    setErrors(fields as FieldErrors<T>);
  }, []);
  const clear = useCallback(() => setErrors({}), []);
  const show = useCallback(
    (field: Path<T>, message: string) => setErrors({ [field]: { message } } as FieldErrors<T>),
    [],
  );
  return { errors, onInvalid, clear, show };
}
