/**
 * Spec 122 US2 — the auth pages' h1. Its own module, with no server-only or
 * client-only imports, so both the server `AuthFrame` and a client form that
 * draws its own title (the email-change revert form) can render it.
 */
/** The auth pages' h1 and its one-line description, as the boards set them (28px on phones, 30px from 1024px). */
export function AuthTitle({ title, description }: { readonly title: string; readonly description?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="font-[family-name:var(--font-display)] text-[28px] leading-[1.2] lg:text-[30px] font-semibold tracking-[-0.01em] text-balance">
        {title}
      </h1>
      {description ? <p className="text-sm leading-6 text-[var(--aura-fg-secondary)]">{description}</p> : null}
    </div>
  );
}
