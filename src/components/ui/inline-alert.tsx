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
const inlineAlertVariants = cva(
  "grid w-full items-start gap-2 rounded-md border px-3 py-2 text-sm has-[>svg]:grid-cols-[auto_1fr] [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:translate-y-0.5",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted/50 text-foreground",
        success:
          "border-success/30 bg-success-surface text-success [&>svg]:text-success",
        warning:
          "border-warning/30 bg-warning-surface text-warning [&>svg]:text-warning",
        info:
          "border-info/30 bg-info-surface text-info [&>svg]:text-info",
        destructive:
          "border-destructive/30 bg-destructive-surface text-destructive [&>svg]:text-destructive",
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
        "col-start-auto font-medium group-has-[>svg]/alert:col-start-2",
        className
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
      className={cn("text-sm opacity-90", className)}
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
