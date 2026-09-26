import type { ReactNode } from 'react';

import { AuthPageControls } from '@/components/shell/auth-page-controls';
import { BrandMark, CHAMBER_FULL_NAME } from '@/components/shell/brand-mark';

/**
 * Spec 122 US2 — the frame every `(auth-public)` page shares, from the
 * `Sign-in` / `Admin-sign-in` / `Auth-*` boards. From 1024px: a mesh brand
 * panel (AURA's Creative texture, one per view) beside a 400px form column.
 * Below 1024px: the brand above the form and no mesh, as the `-mobile`
 * boards draw it. Language and colour scheme stay top right.
 *
 * A server component, so AURA arrives as class names only (`aura-surface`,
 * `aura-mesh`, `aura-grain`), never as an import. Strings come in resolved:
 * the page owns its translations.
 */
export interface AuthFrameProps {
  /** The page's h1. Omit when the content draws its own (the email-change revert form's title follows its state). */
  readonly title?: string;
  /** One line under the title. */
  readonly description?: string;
  /** Who the page is for, under the chamber's name on the brand panel. */
  readonly portalLabel: string;
  readonly tenantName: string;
  readonly children: ReactNode;
}

export function AuthFrame({ title, description, portalLabel, tenantName, children }: AuthFrameProps) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-dvh bg-[var(--aura-bg-surface)] text-[var(--aura-fg-primary)] focus:outline-none lg:grid-cols-2"
    >
      <div className="aura-surface aura-mesh aura-grain auth-mesh flex flex-col justify-between rounded-none p-12 text-[var(--aura-on-texture)] max-lg:hidden">
        <BrandRow tenantName={tenantName} size="panel" />
        <div className="flex flex-col gap-3">
          <p className="font-[family-name:var(--font-display)] text-5xl leading-[1.1] font-semibold tracking-[-0.02em] text-balance">
            {CHAMBER_FULL_NAME}
          </p>
          <p className="text-base">{portalLabel}</p>
        </div>
      </div>

      <div className="relative flex flex-col gap-8 px-6 pt-[88px] pb-8 lg:items-center lg:justify-center lg:p-12">
        <AuthPageControls />
        <div data-slot="auth-brand-compact" className="lg:hidden">
          <BrandRow tenantName={tenantName} size="compact" />
        </div>
        <div className="flex w-full flex-col gap-6 lg:max-w-[400px]">
          {title ? <AuthTitle title={title} description={description} /> : null}
          {children}
        </div>
      </div>
    </main>
  );
}

/** The auth pages' h1 and its one-line description, as the boards set them (28px on phones, 30px from 1024px). */
export function AuthTitle({ title, description }: { readonly title: string; readonly description?: string | undefined }) {
  return (
    <div className="flex flex-col gap-1.5">
      <h1 className="font-[family-name:var(--font-display)] text-[28px] leading-[1.2] lg:text-[30px] font-semibold tracking-[-0.01em] text-balance">
        {title}
      </h1>
      {description ? <p className="text-[var(--aura-fg-secondary)]">{description}</p> : null}
    </div>
  );
}

/** The mark on its white tile, the wordmark in the display face, and AURA's signal dot. */
function BrandRow({ tenantName, size }: { readonly tenantName: string; readonly size: 'panel' | 'compact' }) {
  const panel = size === 'panel';
  return (
    <div className="flex items-center gap-3">
      <span
        className={
          panel
            ? 'flex size-12 shrink-0 items-center justify-center rounded-[var(--aura-radius-lg)] border-2 border-[var(--aura-ink)] bg-white p-1.5'
            : 'flex size-10 shrink-0 items-center justify-center rounded-[var(--aura-radius-md)] border border-[var(--aura-border-default)] bg-white p-[5px]'
        }
      >
        <BrandMark variant="mark" className="size-full" />
      </span>
      <span
        className={`font-[family-name:var(--font-display)] leading-none font-semibold tracking-[-0.01em] ${panel ? 'text-[26px]' : 'text-[22px]'}`}
      >
        {tenantName}
      </span>
      <span className="size-2 shrink-0 rounded-full bg-[var(--aura-accent-dot)]" aria-hidden />
    </div>
  );
}
