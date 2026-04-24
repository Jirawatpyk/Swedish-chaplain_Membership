import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * StatusDot — a 8px colored disc for at-a-glance status in dense surfaces
 * (table rows, list items) where a full <StatusBadge> would be visual noise.
 *
 * An `aria-label` is REQUIRED because color alone fails WCAG 1.4.1 — the
 * dot has no text companion. Callers must pass a localized label, e.g.
 * `aria-label={t('members.status.active')}`.
 */
const statusDotVariants = cva(
  "inline-block size-2 rounded-full align-middle",
  {
    variants: {
      tone: {
        neutral: "bg-muted-foreground",
        success: "bg-success",
        warning: "bg-warning",
        info: "bg-info",
        destructive: "bg-destructive",
      },
      pulse: {
        true: "motion-safe:animate-pulse",
        false: "",
      },
    },
    defaultVariants: {
      tone: "neutral",
      pulse: false,
    },
  }
)

export interface StatusDotProps
  extends Omit<React.ComponentProps<"span">, "aria-label">,
    VariantProps<typeof statusDotVariants> {
  "aria-label": string
}

function StatusDot({
  className,
  tone,
  pulse,
  ...props
}: StatusDotProps) {
  return (
    <span
      data-slot="status-dot"
      data-tone={tone ?? "neutral"}
      role="status"
      className={cn(statusDotVariants({ tone, pulse }), className)}
      {...props}
    />
  )
}

export { StatusDot, statusDotVariants }
