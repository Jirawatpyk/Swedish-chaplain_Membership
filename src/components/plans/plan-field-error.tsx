/**
 * Per-field error plumbing shared by the plan wizard and the plan edit form.
 * Keeps `aria-invalid` / `aria-describedby` on a raw <Input> in step with the
 * message rendered under it.
 */

// `aria-invalid` + `aria-describedby` for a raw <Input> whose message is
// rendered by <FieldError field={id}>.
export function invalidProps(
  id: string,
  message: string | undefined,
): { 'aria-invalid'?: true; 'aria-describedby'?: string } {
  return message ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {};
}

// `exactOptionalPropertyTypes` — spread the `error` prop only when set.
export function optionalError(message: string | undefined): { error?: string } {
  return message ? { error: message } : {};
}

export function FieldError({
  field,
  message,
  focusable = false,
}: {
  readonly field: string;
  readonly message: string | undefined;
  /** For a message no input points at — it receives the error focus itself. */
  readonly focusable?: boolean;
}) {
  if (!message) return null;
  return (
    <p
      id={`${field}-error`}
      className="text-destructive text-sm"
      {...(focusable ? { tabIndex: -1, 'data-field-error': true } : {})}
    >
      {message}
    </p>
  );
}
