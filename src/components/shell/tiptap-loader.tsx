'use client';

/**
 * T035 — Tiptap dynamic-import boilerplate (F7).
 *
 * Tiptap v3 (`@tiptap/react`) requires browser DOM (`document.createElement`,
 * `Range`, `Selection`, etc.) on first render. Server-side rendering would
 * crash with `ReferenceError: document is not defined`. The wrapper below
 * defers loading the editor module to the client + shows a shimmer skeleton
 * while the chunk arrives.
 *
 * **Bundle size**: Tiptap StarterKit ≈ 80 KB gzipped (per plan.md § perf).
 * Loading it eagerly on every member-portal page would blow the
 * compose-page budget (≤180 KB gz per perf.md CHK038). Dynamic import
 * keeps Tiptap out of every other bundle.
 *
 * **Usage** (Phase 3+ T082 will adopt this):
 *
 * ```tsx
 * // src/app/(member)/portal/broadcasts/new/_components/compose-form.tsx
 * 'use client';
 * import { loadTiptapEditor } from '@/components/shell/tiptap-loader';
 *
 * const TiptapEditor = loadTiptapEditor(() => import('./tiptap-editor'));
 *
 * export function ComposeForm() {
 *   return <TiptapEditor onChange={…} initialHtml={…} />;
 * }
 * ```
 *
 * The actual `tiptap-editor.tsx` component (built in T082) calls
 * `useEditor()` from `@tiptap/react` + renders `<EditorContent />`.
 * `useEditor` is a hook — it cannot be dynamically imported standalone.
 * Therefore this loader wraps the WHOLE editor component, not the hook.
 *
 * **Accessibility**: the loading skeleton uses ARIA-live polite via
 * `role="status"` + `aria-live="polite"` so screen readers announce the
 * load state without interrupting other content. The blocks are the shared
 * `SkeletonBlock` (spec 122 US12a moved this loader out of the legacy kit).
 *
 * **Reduced-motion**: the skeleton animation is CSS-driven (see
 * `skeleton-shimmer` class in globals.css); `prefers-reduced-motion: reduce`
 * media query disables the animation per WCAG 2.3.3.
 */

import dynamic from 'next/dynamic';
import { useId, type ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { SkeletonBlock } from '@/components/shell/page-skeletons';

/**
 * Dynamic-loader factory for any Tiptap-based editor component. Returns
 * a `next/dynamic` wrapper with SSR disabled + a shimmer skeleton during
 * load.
 *
 * @param loader async import callback returning a module with `default`
 *               export of the editor component
 * @returns `ComponentType<TProps>` ready to render
 */
export function loadTiptapEditor<TProps>(
  loader: () => Promise<{ default: ComponentType<TProps> }>,
): ComponentType<TProps> {
  return dynamic(loader, {
    ssr: false,
    loading: TiptapLoadingSkeleton,
  }) as ComponentType<TProps>;
}

/**
 * Pulse skeleton shown while the Tiptap chunk loads, and by the editor itself
 * until Tiptap has created its editor (spec 122 US12d-2). Matches the
 * approximate height of the toolbar (≈ 40 px) + editor body
 * (≈ 240 px). Sized to minimise CLS when the real editor mounts.
 */
export function TiptapLoadingSkeleton(): React.ReactElement {
  const t = useTranslations('shell');
  const labelId = useId();
  return (
    <div role="status" aria-live="polite" aria-labelledby={labelId} data-testid="tiptap-loading" className="space-y-3">
      {/* Text that is also the name: a status with no content is not
          announced by every screen reader, and a separate label read it
          twice (spec 122 US12d-2 rounds 2–3). */}
      <span id={labelId} className="sr-only">
        {t('editorLoading')}
      </span>
      {/* The toolbar's real height, so the page does not jump when the editor
          arrives: three 44px rows on a phone, two on a touch screen from
          640px (AURA's touch height follows the pointer), one with a mouse. */}
      <SkeletonBlock className="h-[152px] w-full sm:h-[104px] sm:[@media(pointer:fine)]:h-10" />
      <SkeletonBlock className="h-60 w-full" />
    </div>
  );
}
