/**
 * Spec 122 US2 — the auth pages' h1. Its own module, with no server-only or
 * client-only imports, so both the server `AuthFrame` and a client form that
 * draws its own title (the email-change revert form) can render it.
 */
/**
 * The auth pages' h1 and its one-line description, on the app's shared h1
 * step (`--font-size-h1`: 26px on phones, 32px from 640px), like every other
 * page title (parity rule: the type scale wins over the boards' 28 / 30px).
 * No `text-balance`: the boards wrap the title naturally.
 */
export function AuthTitle({
  title,
  description,
}: {
  readonly title: string;
  readonly description?: string | undefined;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1
        className={`font-[family-name:var(--font-display)] leading-[1.2] font-semibold tracking-[-0.01em] [:lang(th)_&]:leading-[var(--line-height-th)] text-(length:--font-size-h1)`}
      >
        {title}
      </h1>
      {description ? <p className="text-sm leading-6 text-[var(--aura-fg-secondary)]">{description}</p> : null}
    </div>
  );
}
