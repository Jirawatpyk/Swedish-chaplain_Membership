import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * StatusBadge — canonical semantic badge for invoice, payment, member and
 * any other state-machine surfaces.
 *
 * Design-system audit P0 gap B2. Before this primitive existed, F4 invoice
 * status, F5 payment status, and F3 member status each invented their own
 * color treatment off the generic <Badge variant="secondary">, producing
 * visual drift across ~20 call sites.
 *
 * Rules of use:
 *   - Always pair color with an icon or text label — color alone is not a
 *     WCAG 1.4.1 compliant status cue (deuteranopia).
 *   - Pass a localized label via children; do NOT hardcode EN copy here.
 *   - Prefer `tone` over `variant` in call sites so intent is explicit
 *     (tone="success" reads better than variant="success").
 */
const statusBadgeVariants = cva(
  "inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 rounded-4xl border px-2 py-0.5 text-xs font-medium whitespace-nowrap [&>svg]:size-3 [&>svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral:
          "border-border bg-muted text-muted-foreground",
        success:
          "border-transparent bg-success-surface text-success",
        warning:
          "border-transparent bg-warning-surface text-warning",
        info:
          "border-transparent bg-info-surface text-info",
        destructive:
          "border-transparent bg-destructive-surface text-destructive",
      },
      emphasis: {
        subtle: "",
        solid: "",
      },
    },
    compoundVariants: [
      {
        tone: "success",
        emphasis: "solid",
        className: "bg-success text-success-foreground",
      },
      {
        tone: "warning",
        emphasis: "solid",
        className: "bg-warning text-warning-foreground",
      },
      {
        tone: "info",
        emphasis: "solid",
        className: "bg-info text-info-foreground",
      },
      {
        tone: "destructive",
        emphasis: "solid",
        className: "bg-destructive text-destructive-foreground",
      },
      {
        tone: "neutral",
        emphasis: "solid",
        className: "bg-foreground text-background",
      },
    ],
    defaultVariants: {
      tone: "neutral",
      emphasis: "subtle",
    },
  }
)

export interface StatusBadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof statusBadgeVariants> {}

function StatusBadge({
  className,
  tone,
  emphasis,
  ...props
}: StatusBadgeProps) {
  return (
    <span
      data-slot="status-badge"
      data-tone={tone ?? "neutral"}
      data-emphasis={emphasis ?? "subtle"}
      className={cn(statusBadgeVariants({ tone, emphasis }), className)}
      {...props}
    />
  )
}

export { StatusBadge, statusBadgeVariants }
