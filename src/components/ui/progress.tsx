import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * Progress — a WAI-ARIA determinate progress bar.
 *
 * Design-system audit P0 gap B1. F5 PaySheet needs a canonical progress
 * indicator for 3DS polling / webhook wait; without a shared primitive
 * every payment step re-implements a raw <div> bar.
 *
 * For indeterminate state (server action in flight, duration unknown)
 * omit the `value` prop — the track renders with an animated shimmer
 * sweep that degrades to a solid bar under prefers-reduced-motion.
 *
 * Always pair with an accessible label via `aria-label` or `aria-labelledby`.
 */
const progressVariants = cva(
  "relative w-full overflow-hidden rounded-full bg-muted",
  {
    variants: {
      size: {
        sm: "h-1",
        md: "h-2",
        lg: "h-3",
      },
      tone: {
        primary: "[&_[data-slot=progress-fill]]:bg-primary",
        success: "[&_[data-slot=progress-fill]]:bg-success",
        warning: "[&_[data-slot=progress-fill]]:bg-warning",
        info: "[&_[data-slot=progress-fill]]:bg-info",
        destructive: "[&_[data-slot=progress-fill]]:bg-destructive",
      },
    },
    defaultVariants: {
      size: "md",
      tone: "primary",
    },
  }
)

export interface ProgressProps
  extends Omit<React.ComponentProps<"div">, "role">,
    VariantProps<typeof progressVariants> {
  /** 0–100; omit for indeterminate. */
  value?: number
  /** Upper bound (default 100). */
  max?: number
}

function clampPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.min(100, Math.max(0, (value / max) * 100))
}

function Progress({
  className,
  value,
  max = 100,
  size,
  tone,
  "aria-label": ariaLabel,
  "aria-labelledby": ariaLabelledby,
  ...props
}: ProgressProps) {
  const isIndeterminate = value === undefined || value === null
  const percent = isIndeterminate ? 0 : clampPercent(value, max)

  return (
    <div
      data-slot="progress"
      data-state={isIndeterminate ? "indeterminate" : "determinate"}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={isIndeterminate ? undefined : max}
      aria-valuenow={isIndeterminate ? undefined : value}
      aria-label={ariaLabel}
      aria-labelledby={ariaLabelledby}
      className={cn(progressVariants({ size, tone }), className)}
      {...props}
    >
      <div
        data-slot="progress-fill"
        className={cn(
          "h-full rounded-full transition-[width] duration-300 ease-out",
          isIndeterminate &&
            "motion-safe:skeleton-shimmer motion-safe:w-1/3 motion-reduce:w-full motion-reduce:opacity-60",
        )}
        style={isIndeterminate ? undefined : { width: `${percent}%` }}
      />
    </div>
  )
}

export { Progress, progressVariants }
