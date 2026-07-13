/**
 * B3: FieldError requires an `id` so each input can reference it via
 * `aria-describedby`. Pattern matches portal-edit-form.tsx exactly.
 *
 * Shared by the composition root + every section (extracted in PR-B task 4 —
 * pure move, no behaviour change).
 */
export function FieldError({
  id,
  message,
}: {
  id: string;
  message: string | undefined;
}) {
  if (!message) return null;
  return (
    <p id={id} className="mt-1 text-xs text-destructive" role="alert">
      {message}
    </p>
  );
}
