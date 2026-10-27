/**
 * The E-Blast sending rules and the tenant's privacy link, shared by the
 * portal banner and the compose page (spec 122 PR C) so they say the same
 * thing and wrap the same way.
 */
export function BroadcastsRulesBody({
  body,
  privacyPolicyUrl,
  privacyPolicyLinkLabel,
}: {
  readonly body: string;
  readonly privacyPolicyUrl?: string | null | undefined;
  readonly privacyPolicyLinkLabel?: string | undefined;
}): React.ReactElement {
  return (
    <>
      <p>{body}</p>
      {privacyPolicyUrl && privacyPolicyLinkLabel ? (
        <p className="text-sm">
          <a
            href={privacyPolicyUrl}
            target="_blank"
            rel="noopener noreferrer"
            // `inline-block max-w-full` — the short link phrase stays whole
            // (TH "อ่านนโยบายความเป็นส่วนตัว" has no spaces) and breaks only
            // when it is wider than the line, e.g. at 200% text on a phone
            // (WCAG 1.4.4). `whitespace-nowrap` pushed it past the viewport.
            className="inline-block max-w-full font-medium text-[var(--aura-fg-accent)] underline underline-offset-2 hover:text-[var(--aura-fg-primary)]"
          >
            {privacyPolicyLinkLabel}
          </a>
        </p>
      ) : null}
    </>
  );
}
