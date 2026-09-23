/**
 * F119 T013 — the ONE broadcast content policy (SC-011, research R9).
 *
 * Every stage that sanitises E-Blast HTML reads THIS config: the editor's
 * paste handler (client), the server `HtmlSanitizerPort` adapter, and the
 * test-copy / preview / send path (which sanitise on the server and then
 * render through the same wrapper). Three divergent copies used to live in
 * `tiptap-editor.tsx`, `dompurify-sanitizer.ts` and `preview-pane.tsx`, and
 * they disagreed (`target`/`rel` missing on paste; `<img>` forbidden in the
 * preview so uploaded images were invisible) — which is exactly the
 * "silently stripped between editor and delivered email" class SC-011
 * forbids.
 *
 * Pure, import-free data — readable by a client component without a
 * Presentation → Domain import (Principle III; `src/lib/email-brand.ts` is
 * the precedent for email policy in `src/lib`).
 *
 * What the policy keeps (FR-002a + FR-038 + FR-041):
 *   tags   p br strong em u a ul ol li h1–h4 blockquote hr [img]
 *   attrs  href target rel src alt data-eb
 *   schemes http https mailto (anchors); http https only on <img src>
 *          (enforced by the server hook; the dialog refuses earlier)
 * What it never keeps: `style` and `class` (so text alignment, colours and
 * fonts are impossible by construction — out of scope by decision), any
 * `on*` handler, script/style/iframe/form/link/meta/base/object/embed/svg.
 *
 * `data-eb` is the design-block marker (`"cta"` on `<a>`, `"banner"` on
 * `<img>`) — see `domain/design-blocks/block-markers.ts`. `ALLOW_DATA_ATTR`
 * is switched OFF so `data-eb` is the ONLY data attribute that survives.
 */

export const BROADCAST_ALLOWED_TAGS_BASE = [
  'p',
  'br',
  'strong',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'blockquote',
  'hr',
] as const;

export const BROADCAST_ALLOWED_ATTR = ['href', 'target', 'rel', 'src', 'alt', 'data-eb'] as const;

export const BROADCAST_FORBID_TAGS_BASE = [
  'script',
  'style',
  'iframe',
  'form',
  'link',
  'meta',
  'base',
  'object',
  'embed',
  'svg',
] as const;

/** Anchor scheme allow-list — the link dialog and the CTA validator use the same rule. */
export const BROADCAST_ALLOWED_URI_REGEXP = /^(?:https?:|mailto:)/i;

/** The design-block marker attribute and its two known values. */
export const DESIGN_BLOCK_ATTR = 'data-eb' as const;
export const DESIGN_BLOCK_MARKERS = ['cta', 'banner'] as const;

export interface BroadcastSanitizerConfig {
  readonly ALLOWED_TAGS: readonly string[];
  readonly ALLOWED_ATTR: readonly string[];
  readonly ALLOWED_URI_REGEXP: RegExp;
  /**
   * DOMPurify applies `ALLOWED_URI_REGEXP` to EVERY attribute whose value
   * does not match it, not only to URL attributes — so without this list
   * `target="_blank"`, `rel="noopener…"` and `data-eb="cta"` are silently
   * stripped (the pre-F119 editor lost target/rel that way, and the server
   * only had them because its hook re-added them after the fact — the
   * original SC-011 divergence). These three are exempt from the URI check.
   */
  readonly ADD_URI_SAFE_ATTR: readonly string[];
  readonly FORBID_TAGS: readonly string[];
  readonly FORBID_ATTR: readonly string[];
  readonly ALLOW_DATA_ATTR: false;
  readonly KEEP_CONTENT: true;
  readonly RETURN_TRUSTED_TYPE: false;
}

/**
 * The DOMPurify config every consumer passes as-is.
 *
 * `images: false` is the member editor while the F7.1a US2 image flag is
 * off: `<img>` is forbidden outright (so a banner is impossible there too).
 * Everything else — including `data-eb` on anchors — is identical in both
 * shapes, so a document a member wrote without images renders the same at
 * every stage.
 */
export function makeBroadcastSanitizerConfig(opts: { readonly images: boolean }): BroadcastSanitizerConfig {
  return Object.freeze({
    ALLOWED_TAGS: opts.images ? [...BROADCAST_ALLOWED_TAGS_BASE, 'img'] : [...BROADCAST_ALLOWED_TAGS_BASE],
    ALLOWED_ATTR: [...BROADCAST_ALLOWED_ATTR],
    ALLOWED_URI_REGEXP: BROADCAST_ALLOWED_URI_REGEXP,
    ADD_URI_SAFE_ATTR: ['target', 'rel', DESIGN_BLOCK_ATTR],
    FORBID_TAGS: opts.images ? [...BROADCAST_FORBID_TAGS_BASE] : [...BROADCAST_FORBID_TAGS_BASE, 'img'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });
}

/**
 * The structural shape DOMPurify exposes for hooks — declared here so this
 * module stays import-free (it must be readable by a client component).
 */
export interface SanitizerHookHost {
  addHook(
    entryPoint: 'afterSanitizeAttributes',
    hook: (node: unknown) => void,
  ): void;
}

const hooked = new WeakSet<SanitizerHookHost>();

/**
 * The ONE post-attribute hook, installed once per DOMPurify instance on
 * BOTH the client paste path and the server adapter — so a paste can never
 * keep what the server later changes:
 *
 *   1. Link hardening — every surviving `<a href>` carries
 *      `rel="noopener noreferrer nofollow"` + `target="_blank"` (chamber
 *      sender reputation decoupled from outbound links; no tab-napping).
 *   2. `<img src>` scheme guard — http(s) only (FR-014): DOMPurify itself
 *      lets a `data:` URI through on `<img>`, and a base64 body would
 *      inflate past every cap. The src is removed, the element stays as a
 *      visible broken image (the author sees the URL was refused).
 *   3. Angle brackets stripped from EVERY surviving attribute value
 *      (security review F1-1, 2026-09-22). HTML attribute serialisation
 *      escapes only `&`, NBSP and `"` — NOT `<` / `>` — and `alt` is in
 *      DOMPurify's default URI-safe set, so
 *      `alt="x&gt;&lt;img src=q onerror=…&gt;"` came back out of the
 *      sanitiser carrying a RAW `>`. The design-block marker scanner
 *      (`domain/design-blocks/block-markers.ts`) matches an opening tag with
 *      `[^>]*`, so that `>` ended the banner span early and
 *      `applyDesignBlocks` re-emitted the tail as raw markup in the
 *      delivered email — whose output is deliberately never re-sanitised.
 *      No allow-listed attribute (href / src / alt / target / rel /
 *      data-eb) has a legitimate use for `<` or `>`, so stripping them here
 *      makes `[^>]*` structurally sound on the editor and the server alike,
 *      one hop above every consumer.
 *
 * None of them touches the VALUE of `data-eb` beyond that strip: the
 * design-block marker is user content the policy keeps, and the renderer
 * consumes it after sanitisation.
 */
export function installBroadcastSanitizerHooks(purify: SanitizerHookHost): void {
  if (hooked.has(purify)) return;
  purify.addHook('afterSanitizeAttributes', (node) => {
    // No `instanceof Element`: on Node the global comes from jsdom inside
    // isomorphic-dompurify and the realm may differ — check the shape.
    const el = node as {
      nodeType?: number;
      tagName?: string;
      attributes?: ArrayLike<{ readonly name?: unknown; readonly value?: unknown }>;
      hasAttribute?: (name: string) => boolean;
      setAttribute?: (name: string, value: string) => void;
      getAttribute?: (name: string) => string | null;
      removeAttribute?: (name: string) => void;
    };
    if (el.nodeType !== 1) return;
    // (3) — runs FIRST and for every element, including the `<a>` that
    // returns early below. Rewriting an existing attribute's value in place
    // does not change `attributes.length`, so the live NamedNodeMap is stable
    // across this loop.
    const attributes = el.attributes;
    if (attributes !== undefined && typeof el.setAttribute === 'function') {
      for (let i = 0; i < attributes.length; i += 1) {
        const attr = attributes[i];
        if (attr === undefined) continue;
        const { name, value } = attr;
        if (typeof name !== 'string' || typeof value !== 'string') continue;
        if (!value.includes('<') && !value.includes('>')) continue;
        el.setAttribute(name, value.replace(/[<>]/g, ''));
      }
    }
    if (
      el.tagName === 'A' &&
      typeof el.hasAttribute === 'function' &&
      typeof el.setAttribute === 'function' &&
      el.hasAttribute('href')
    ) {
      el.setAttribute('rel', 'noopener noreferrer nofollow');
      el.setAttribute('target', '_blank');
      return;
    }
    if (
      el.tagName === 'IMG' &&
      typeof el.getAttribute === 'function' &&
      typeof el.removeAttribute === 'function'
    ) {
      const src = el.getAttribute('src') ?? null;
      if (src === null || !/^https?:\/\//i.test(src)) {
        el.removeAttribute('src');
      }
    }
  });
  hooked.add(purify);
}
