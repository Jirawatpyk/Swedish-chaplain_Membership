/**
 * Spec 122 US9c — the read-only value box on the EventCreate integration
 * page (board `Admin-eventcreate`): the webhook URL, the masked secret and
 * the one-time reveal show their value in a mono box on the hover surface,
 * wrapping anywhere so a long URL never widens a phone screen.
 *
 * A `<code>`, not an input: the value is read and copied, never edited, and
 * e2e reads the secret from `code` / `data-testid="webhook-secret-value"`.
 * The label is the wrapping group's (`role="group" aria-labelledby`).
 */
import type { HTMLAttributes } from 'react';

export function WebhookValueBox({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <code
      {...rest}
      className={[
        'aura-text-mono min-w-0 flex-1 rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]',
        'bg-[var(--aura-bg-surface-hover)] px-[var(--aura-space-3)] py-[var(--aura-space-2)] [overflow-wrap:anywhere]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}
