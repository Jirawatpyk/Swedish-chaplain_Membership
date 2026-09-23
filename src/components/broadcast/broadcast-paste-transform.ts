/**
 * F119 T101 (FR-038) — the editor's paste path: content outside the shared
 * policy is dropped AT PASTE TIME, and the author is told ONCE per editing
 * session.
 *
 * A factory rather than an inline closure so "once per session" has a seam: a
 * transform instance is created per mounted editor, and the `told` latch lives
 * on it. A new editor (new draft, remount) is a new session. The pre-F119
 * editor throttled on a 1.5 s timestamp instead, so pasting five paragraphs
 * from Word produced a stack of identical warnings.
 *
 * It sanitises with the ONE shared config + the ONE shared post-attribute hook
 * (`src/lib/broadcast-content-policy.ts`), so a paste can never keep what the
 * server later strips, nor strip what the server keeps (SC-011).
 *
 * The notice fires on what DOMPurify REMOVED, never on "the output differs
 * from the input": the shared hook ADDS `rel="noopener noreferrer nofollow"`
 * and `target="_blank"` to every surviving link, so a difference is not
 * evidence of a loss. Telling an author their formatting was stripped when a
 * perfectly-kept link was merely hardened teaches them to ignore the notice.
 */
import DOMPurify from 'isomorphic-dompurify';
import {
  installBroadcastSanitizerHooks,
  makeBroadcastSanitizerConfig,
} from '@/lib/broadcast-content-policy';

export interface BroadcastPasteTransformOptions {
  /** Mirrors the editor's image flag — `<img>` is unsupported content while it is off. */
  readonly images: boolean;
  /** Shown once per session. The editor passes the non-blocking `toast.warning`. */
  readonly notify: () => void;
}

export function makeBroadcastPasteTransform(
  opts: BroadcastPasteTransformOptions,
): (html: string) => string {
  const config = makeBroadcastSanitizerConfig({ images: opts.images });
  let told = false;

  return function transformPastedHtml(html: string): string {
    installBroadcastSanitizerHooks(DOMPurify);
    const sanitised = DOMPurify.sanitize(
      html,
      config as Parameters<typeof DOMPurify.sanitize>[1],
    ) as string;

    // `DOMPurify.removed` is reset at the start of every `sanitize()` call and
    // lists the elements and attributes this pass threw away. Falling back to
    // a string comparison would be wrong (see the docblock), so when the
    // property is missing we say nothing rather than cry wolf.
    const removed = (DOMPurify as unknown as { removed?: readonly unknown[] }).removed;

    // DOMPurify parses into a `<body>` wrapper and then reports that wrapper as
    // removed on EVERY call, because `body` is not in the allow-list. Counting
    // it would make the notice fire on every paste, including a paste the
    // policy keeps whole — measured, not assumed (it is the single entry for
    // `<p><strong>Bold</strong></p>`).
    const droppedSomething =
      Array.isArray(removed) &&
      removed.some((entry) => {
        const record = entry as {
          readonly element?: { readonly nodeName?: string };
          readonly attribute?: unknown;
        };
        if (record.attribute !== undefined) return true;
        const nodeName = record.element?.nodeName?.toUpperCase();
        return nodeName !== 'BODY' && nodeName !== 'HTML' && nodeName !== 'HEAD';
      });

    if (droppedSomething && !told) {
      told = true;
      opts.notify();
    }
    return sanitised;
  };
}
