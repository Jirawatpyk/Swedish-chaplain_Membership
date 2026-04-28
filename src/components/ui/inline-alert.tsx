import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * InlineAlert — a compact semantic alert for use inside forms, cards, or
 * detail views. Unlike <Alert> (card-style, stands alone), InlineAlert
 * inherits the surrounding container's spacing and is meant to live beside
 * form fields or above primary CTAs.
 *
 * Variants reuse the semantic-color tokens (A1) so tone changes cascade
 * automatically through dark mode and future tenant-theme overrides.
 *
 * Accessibility:
 *   - `role="alert"` by default so screen readers announce immediately.
 *   - Callers may pass `role="status"` for non-urgent info that should use
 *     the polite live region (e.g. "Autosave enabled").
 */
// Layout mirrors `<Alert>` (src/components/ui/alert.tsx) so call sites
// that embed an icon + title + description render identically: svg goes
// into col 1 / row-span-2, title into col 2 row 1, description into col
// 2 row 2. When no svg is present the grid collapses to a single
// implicit column and Title/Description inherit the default flow
// (the `group-has-[>svg]/inline-alert:col-start-2` on the subcomponents
// only forces col 2 when an svg sibling exists — this keeps no-icon
// call sites like PaySheet failure + PriorYearLockBanner flush-left
// instead of indented into an empty col 1).
const inlineAlertVariants = cva(
  "group/inline-alert relative grid w-full gap-0.5 rounded-md border px-3 py-2 text-left text-sm has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2 *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted/50 text-foreground",
        success: "border-success/30 bg-success-surface text-success",
        warning: "border-warning/30 bg-warning-surface text-warning",
        info: "border-info/30 bg-info-surface text-info",
        destructive:
          "border-destructive/30 bg-destructive-surface text-destructive",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  }
)

export interface InlineAlertProps
  extends React.ComponentProps<"div">,
    VariantProps<typeof inlineAlertVariants> {}

function InlineAlert({
  className,
  tone,
  role = "alert",
  ...props
}: InlineAlertProps) {
  return (
    <div
      data-slot="inline-alert"
      data-tone={tone ?? "neutral"}
      role={role}
      className={cn(inlineAlertVariants({ tone }), className)}
      {...props}
    />
  )
}

function InlineAlertTitle({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-alert-title"
      className={cn(
        "font-medium group-has-[>svg]/inline-alert:col-start-2",
        className,
      )}
      {...props}
    />
  )
}

function InlineAlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="inline-alert-description"
      className={cn(
        "text-sm opacity-90 group-has-[>svg]/inline-alert:col-start-2 [&_p:not(:last-child)]:mb-2",
        className,
      )}
      {...props}
    />
  )
}

export {
  InlineAlert,
  InlineAlertTitle,
  InlineAlertDescription,
  inlineAlertVariants,
}
