/**
 * Spec 122 US12c-1 (parity, 20 Oct) — the e-mail as the boards draw it on the
 * staff detail: its own bordered, rounded frame inside the card, so the
 * delivered message reads as a document apart from the page's chrome.
 */
export function EmailFrame({ children }: { readonly children: React.ReactNode }): React.ReactElement {
  return (
    <div data-email-frame className="overflow-hidden rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)]">
      {children}
    </div>
  );
}
