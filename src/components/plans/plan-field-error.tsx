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
      className="text-[var(--aura-fg-danger)]"
      {...(focusable ? { tabIndex: -1, 'data-field-error': true } : {})}
    >
      {message}
    </p>
  );
}

/**
 * Focus a field, first opening the language tab it sits behind: the plan
 * name and description show one language at a time, and a field in a hidden
 * panel cannot take focus (UX review, US6).
 */
export function focusField(field: HTMLElement | null): void {
  if (!field) return;
  const panel = field.closest<HTMLElement>('[role="tabpanel"][hidden]');
  const tabId = panel?.getAttribute('aria-labelledby');
  // A click is a discrete event: React commits the tab switch before it
  // returns, so the panel is visible by the time the field is focused.
  if (tabId) document.getElementById(tabId)?.click();
  field.focus();
}
