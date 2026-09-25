/**
 * PR #392 review D4 — the inline WARNING an approval dialog shows when it
 * stays open over a refusal that is nobody's error: main #390's read-only
 * write freeze ("The system is currently in read-only mode … Nothing was
 * changed. Try again in a few minutes."). #390's hook calls it "a WARNING, not
 * an error", so it is the warning-tone `InlineAlert`, never the red
 * `InlineError`, and it carries the title AND the description — the toast
 * that used to say the description sat behind the modal, hidden from AT.
 *
 * Same contract as `InlineError` otherwise: `role="alert"` (announced on first
 * appearance — callers mount it only while there is a refusal and clear it at
 * the start of every request), and `tabIndex={-1}` with an `id`, so the
 * caller's focus-refusal hook can focus it (ux-standards § 6.4).
 */
import { TriangleAlert } from 'lucide-react';
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/ui/inline-alert';

export interface InlineWarningProps {
  readonly id: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly 'data-testid'?: string;
}

export function InlineWarning({ id, title, description, ...rest }: InlineWarningProps): React.ReactElement {
  return (
    <InlineAlert id={id} tone="warning" role="alert" tabIndex={-1} {...rest}>
      <TriangleAlert aria-hidden="true" />
      <InlineAlertTitle>{title}</InlineAlertTitle>
      {description !== undefined ? <InlineAlertDescription>{description}</InlineAlertDescription> : null}
    </InlineAlert>
  );
}
