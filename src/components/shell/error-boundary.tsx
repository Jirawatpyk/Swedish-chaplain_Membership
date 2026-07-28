'use client';

/**
 * Minimal client-side React error boundary (no third-party dependency —
 * Constitution Principle X, Simplicity). React error boundaries can only be
 * class components (no hook equivalent as of React 19).
 *
 * Fix round 2 (renewals money-band review) — the renewals pipeline's
 * `PipelineMoneyBandSection` (an async Server Component) already wraps its
 * DATA fetch in try/catch and degrades to `null` on failure, but a throw
 * during the money band's OWN RENDER was uncaught and would have bubbled to
 * the route's `error.tsx`, crashing the whole pipeline page. `children` is
 * typically a Server Component subtree passed down from a Server Component
 * parent (`<ErrorBoundary><PipelineMoneyBandContent .../></ErrorBoundary>`)
 * — a supported RSC composition: the boundary need only run on the client to
 * intercept the hydration-time throw that Next.js's Flight protocol
 * re-raises for a Server Component render error under the nearest Suspense
 * boundary.
 *
 * Kept generic/reusable, but today only the renewals money band
 * (`pipeline-money-band.tsx`) uses it — this fix round scopes the
 * render-error guarantee to that ONE best-effort section, not the whole page.
 */
import { Component, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  readonly children: ReactNode;
  /**
   * Rendered in place of `children` after a render throw. Defaults to
   * `null` — matching the money band's best-effort intent: a section
   * failing to render must never crash the surrounding page.
   */
  readonly fallback?: ReactNode;
}

interface ErrorBoundaryState {
  readonly hasError: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown): void {
    // Browser console only — no pino here (this runs client-side) and no
    // PII/tenant context in this generic primitive. A caller needing
    // structured server-side telemetry should log from its own data-fetch
    // path (as `PipelineMoneyBandSection` already does) rather than here.
    window.console.error('[ErrorBoundary] render error caught; rendering fallback', error);
  }

  override render(): ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}
