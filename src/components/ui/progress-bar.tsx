import * as React from "react"

import { cn } from "@/lib/utils"
import { Progress, type ProgressProps } from "@/components/ui/progress"

/**
 * ProgressBar — labeled <Progress> with visible numeric readout.
 *
 * Use when the progress value is meaningful to the user (upload %, quota
 * used, tier completion). For pure "something is happening" feedback,
 * prefer the bare <Progress> without a label.
 *
 * Formatting is delegated to the caller via `formatValue` so locale-aware
 * number rendering (Intl.NumberFormat) stays at the consumer — the
 * primitive never hardcodes a locale.
 */
export interface ProgressBarProps extends ProgressProps {
  /** Localized label above the bar, e.g. t('quota.upload.progress'). */
  label: string
  /**
   * Readout formatter. Defaults to "{percent}%". Receives the clamped
   * percent (0–100) and the raw value/max so callers can render
   * "1.2 MB of 5 MB" instead.
   */
  formatValue?: (percent: number, value: number, max: number) => string
  /** If true, render the label visually hidden (still in a11y tree). */
  hideLabel?: boolean
}

function defaultFormat(percent: number): string {
  return `${Math.round(percent)}%`
}

function ProgressBar({
  label,
  formatValue = defaultFormat,
  hideLabel = false,
  value,
  max = 100,
  className,
  ...props
}: ProgressBarProps) {
  const labelId = React.useId()
  const isIndeterminate = value === undefined || value === null
  const percent = isIndeterminate
    ? 0
    : Math.min(100, Math.max(0, ((value ?? 0) / max) * 100))
  const readout = isIndeterminate
    ? null
    : formatValue(percent, value ?? 0, max)

  return (
    <div data-slot="progress-bar" className={cn("grid gap-1.5", className)}>
      <div
        className={cn(
          "flex items-center justify-between gap-2 text-caption text-muted-foreground",
          hideLabel && "sr-only",
        )}
      >
        <span id={labelId}>{label}</span>
        {readout !== null && <span aria-hidden="true">{readout}</span>}
      </div>
      <Progress
        // Under `exactOptionalPropertyTypes: true` we must omit `value`
        // entirely when it is undefined (indeterminate mode) instead of
        // passing `value: undefined` — the ProgressProps type rejects the
        // latter.
        {...(value === undefined ? {} : { value })}
        max={max}
        aria-labelledby={labelId}
        {...props}
      />
    </div>
  )
}

export { ProgressBar }
