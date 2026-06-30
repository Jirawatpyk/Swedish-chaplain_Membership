/**
 * RequiredMark — the visual "*" shown next to a required field's label.
 *
 * ux-standards.md § 11.1: the asterisk MUST be `aria-hidden` (so screen
 * readers don't announce the literal "star"), and the field's required state
 * is conveyed programmatically via `aria-required="true"` on the input itself.
 * Centralising the markup stops each form re-introducing the un-hidden
 * `<span className="text-destructive">*</span>` copy-paste (audit XF-05).
 *
 * Usage:
 *   <Label htmlFor="email">{t('email')} <RequiredMark /></Label>
 *   <Input id="email" aria-required="true" … />
 */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-destructive">
      *
    </span>
  );
}
