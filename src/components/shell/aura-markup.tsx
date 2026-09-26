/**
 * Spec 122 — AURA's look for server components.
 *
 * Server files never import `@jirawatpyk/aura-react` (docs/aura-adoption.md:
 * the whole barrel would ship on every route). These helpers write the same
 * markup AURA's Card, Badge, StatusPill and Alert render, with its class names, so a
 * server page gets the AURA look without the client bundle.
 * `tests/unit/components/shell/aura-markup.test.tsx` renders each one next to
 * AURA's own component and compares the HTML, so they cannot drift apart.
 *
 * Anything interactive (a Switch, Tabs, a Dialog) still needs AURA's real
 * component inside a `'use client'` file.
 */
import * as React from 'react';
import {
  Ban,
  Circle,
  CircleAlert,
  CircleCheck,
  CircleDotDashed,
  Info,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';

function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export interface AuraCardProps extends Omit<React.HTMLAttributes<HTMLElement>, 'title'> {
  readonly title?: React.ReactNode | undefined;
  readonly description?: React.ReactNode | undefined;
  /** Top-right, e.g. a link button. */
  readonly actions?: React.ReactNode | undefined;
  readonly footer?: React.ReactNode | undefined;
  readonly children?: React.ReactNode | undefined;
  /** Default 3, as AURA's; 2 when the card sits directly under the page h1. */
  readonly headingLevel?: 2 | 3 | 4 | 5 | 6 | undefined;
  /** Labels the card by its title (aria-labelledby). */
  readonly titleId?: string | undefined;
  readonly as?: 'section' | 'div' | 'article' | 'aside' | undefined;
  readonly className?: string | undefined;
}

/** AURA `Card`: a bordered container for one topic. */
export function AuraCard({
  title,
  description,
  actions,
  footer,
  children,
  headingLevel = 3,
  titleId,
  as: Tag = 'section',
  className,
  ...rest
}: AuraCardProps) {
  const Heading = `h${headingLevel}` as const;
  return (
    <Tag {...rest} className={cx('aura-card', className)} aria-labelledby={title && titleId ? titleId : undefined}>
      {title || actions ? (
        <div className="aura-card__head">
          <div className="aura-card__heading">
            {title ? (
              <Heading className="aura-card__title" id={titleId}>
                {title}
              </Heading>
            ) : null}
            {description ? <p className="aura-card__desc">{description}</p> : null}
          </div>
          {actions ? <div className="aura-card__actions">{actions}</div> : null}
        </div>
      ) : null}
      {children ? <div className="aura-card__body">{children}</div> : null}
      {footer ? <div className="aura-card__foot">{footer}</div> : null}
    </Tag>
  );
}

export type AuraTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface AuraBadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  readonly tone?: AuraTone | undefined;
  readonly variant?: 'soft' | 'solid' | 'outline' | undefined;
}

/** AURA `Badge`: a small static label ("Primary", "Portal linked", a count). */
export function AuraBadge({ tone = 'neutral', variant, className, children, ...rest }: AuraBadgeProps) {
  return (
    <span
      {...rest}
      className={cx(
        'aura-badge',
        `aura-badge--${tone}`,
        variant === 'solid' && 'is-solid',
        variant === 'outline' && 'is-outline',
        className,
      )}
    >
      {children}
    </span>
  );
}

export type AuraStatusTone = 'neutral' | 'progress' | 'ready' | 'warning' | 'blocked';

// AURA StatusPill's icon per tone (circle, circle-dot-dashed, circle-check,
// triangle-alert, ban), from lucide, which AURA's own icons are drawn from.
const PILL_ICON: Record<AuraStatusTone, LucideIcon> = {
  neutral: Circle,
  progress: CircleDotDashed,
  ready: CircleCheck,
  warning: TriangleAlert,
  blocked: Ban,
};

export interface AuraStatusPillProps {
  /** Pass it: AURA guesses the tone from English words, and ours are translated. */
  readonly tone: AuraStatusTone;
  readonly children: React.ReactNode;
  readonly className?: string | undefined;
}

/** AURA `StatusPill`: a record's state as a tone fill, an icon and the status word. */
export function AuraStatusPill({ tone, children, className }: AuraStatusPillProps) {
  const Icon = PILL_ICON[tone];
  return (
    <span className={cx('aura-pill', `aura-pill--${tone}`, className)}>
      <Icon size={12} className="aura-icon" aria-hidden="true" focusable="false" />
      {children}
    </span>
  );
}

export type AuraFeedbackTone = 'info' | 'success' | 'warning' | 'danger';

// AURA Alert's icon per tone (info, circle-check, triangle-alert, circle-alert).
const ALERT_ICON: Record<AuraFeedbackTone, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  warning: TriangleAlert,
  danger: CircleAlert,
};

export interface AuraAlertProps {
  readonly tone?: AuraFeedbackTone | undefined;
  readonly title?: React.ReactNode | undefined;
  readonly children?: React.ReactNode | undefined;
  /** Usually a secondary link button. */
  readonly action?: React.ReactNode | undefined;
  /**
   * AURA's default: `alert` for warning / danger, `status` otherwise. Override
   * for a standing notice that should not interrupt (e.g. "benefits paused").
   */
  readonly role?: 'alert' | 'status' | undefined;
  /** Replaces the tone's icon when a distinct shape carries meaning. */
  readonly icon?: LucideIcon | undefined;
  readonly className?: string | undefined;
}

/** AURA `Alert`: an inline message that stays until the situation changes. */
export function AuraAlert({ tone = 'info', title, children, action, role, icon, className }: AuraAlertProps) {
  const Icon = icon ?? ALERT_ICON[tone];
  return (
    <div
      className={cx('aura-alert', `aura-alert--${tone}`, className)}
      role={role ?? (tone === 'danger' || tone === 'warning' ? 'alert' : 'status')}
    >
      <Icon size={16} className="aura-icon aura-alert__icon" aria-hidden="true" focusable="false" />
      <div className="aura-alert__body">
        {title ? <p className="aura-alert__title">{title}</p> : null}
        {children ? <div className="aura-alert__text">{children}</div> : null}
        {action ? <div className="aura-alert__action">{action}</div> : null}
      </div>
    </div>
  );
}

export interface AuraButtonClassOptions {
  readonly variant?: 'primary' | 'secondary' | 'ghost' | 'creative' | 'danger' | 'danger-secondary' | undefined;
  readonly size?: 'sm' | 'md' | undefined;
  readonly fullWidth?: boolean | undefined;
}

/** The classes AURA `Button` gives itself, for a server-rendered link that looks like one. */
export function auraButtonClass({ variant = 'primary', size, fullWidth }: AuraButtonClassOptions = {}): string {
  return cx('aura-btn', `aura-btn--${variant}`, size === 'sm' && 'aura-btn--sm', fullWidth && 'aura-btn--full');
}
