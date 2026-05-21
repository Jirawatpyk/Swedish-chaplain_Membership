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
 * import { loadTiptapEditor } from '@/components/ui/tiptap-loader';
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
 * load state without interrupting other content. Per `docs/ux-standards.md`
 * § 2.1 shimmer-skeleton convention.
 *
 * **Reduced-motion**: the shimmer animation is CSS-driven (see
 * `skeleton-shimmer` class in globals.css); `prefers-reduced-motion: reduce`
 * media query disables the animation per WCAG 2.3.3.
 */

import dynamic from 'next/dynamic';
import type { ComponentType } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/skeleton';

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
 * Shimmer skeleton shown while the Tiptap chunk loads. Matches the
 * approximate height of the toolbar (≈ 40 px) + editor body
 * (≈ 240 px). Sized to minimise CLS when the real editor mounts.
 */
function TiptapLoadingSkeleton(): React.ReactElement {
  const t = useTranslations('shell');
  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={t('editorLoading')}
      data-testid="tiptap-loading"
      className="space-y-3"
    >
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-60 w-full" />
    </div>
  );
}
