/**
 * Spec 122 US2 — the auth pages' h1. Its own module, with no server-only or
 * client-only imports, so both the server `AuthFrame` and a client form that
 * draws its own title (the email-change revert form) can render it.
 */
/**
 * The auth pages' h1 and its one-line description, as the boards set them:
 * 28px on phones and 30px from 1024px; the sign-in boards draw 30px on phones
 * too (`size="lg"`). No `text-balance`: the boards wrap the title naturally.
 */
export function AuthTitle({
  title,
  description,
  size = 'default',
}: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly size?: 'default' | 'lg';
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1
        className={`font-[family-name:var(--font-display)] leading-[1.2] font-semibold tracking-[-0.01em] [:lang(th)_&]:leading-[var(--line-height-th)] ${size === 'lg' ? 'text-[30px]' : 'text-[28px] lg:text-[30px]'}`}
      >
        {title}
      </h1>
      {description ? <p className="text-sm leading-6 text-[var(--aura-fg-secondary)]">{description}</p> : null}
    </div>
  );
}
