import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * Stepper — linear progress indicator for multi-step flows.
 *
 * Design-system audit P0 gap B1. F5 PaySheet (confirm → authorize →
 * succeed) and future F4 refund flow need a canonical step UI so the
 * visual language for "which step are you on" stays consistent.
 *
 * Rendering:
 *   - status "complete"  → filled primary circle + check icon
 *   - status "current"   → outlined primary circle + index number
 *   - status "upcoming"  → muted circle + index number
 *
 * Accessibility:
 *   - The container exposes role=list and `aria-label` required.
 *   - The current step carries `aria-current="step"` so SR users can
 *     jump directly to it.
 *   - Connectors are `aria-hidden` decorative elements.
 */
export type StepperStatus = "complete" | "current" | "upcoming"

export interface StepperStep {
  /** Unique per stepper instance; used as React key. */
  id: string
  /** Localized label shown under the circle. */
  label: string
  /** Optional secondary description; appears below label at smaller size. */
  description?: string
  status: StepperStatus
}

export interface StepperProps
  extends Omit<React.ComponentProps<"ol">, "aria-label"> {
  steps: StepperStep[]
  /** Localized `aria-label` describing the flow, e.g. t('payment.steps.label'). */
  "aria-label": string
  orientation?: "horizontal" | "vertical"
}

function Stepper({
  steps,
  className,
  orientation = "horizontal",
  ...props
}: StepperProps) {
  return (
    <ol
      data-slot="stepper"
      data-orientation={orientation}
      className={cn(
        "flex w-full",
        orientation === "horizontal"
          ? "flex-row items-start gap-2"
          : "flex-col gap-4",
        className,
      )}
      {...props}
    >
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1
        return (
          <li
            key={step.id}
            data-slot="stepper-step"
            data-status={step.status}
            aria-current={step.status === "current" ? "step" : undefined}
            className={cn(
              "flex min-w-0 flex-1",
              orientation === "horizontal"
                ? "flex-col items-center text-center"
                : "flex-row items-start gap-3",
            )}
          >
            <div
              className={cn(
                "flex items-center",
                orientation === "horizontal" && "w-full",
              )}
            >
              {orientation === "horizontal" && index > 0 && (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    "h-px flex-1",
                    step.status === "upcoming"
                      ? "bg-border"
                      : "bg-primary",
                  )}
                />
              )}
              <span
                data-slot="stepper-indicator"
                className={cn(
                  "relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors",
                  step.status === "complete" &&
                    "border-primary bg-primary text-primary-foreground",
                  step.status === "current" &&
                    "border-primary bg-background text-primary",
                  step.status === "upcoming" &&
                    "border-border bg-muted text-muted-foreground",
                )}
              >
                {step.status === "complete" ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : (
                  <span aria-hidden="true">{index + 1}</span>
                )}
              </span>
              {orientation === "horizontal" && !isLast && (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    "h-px flex-1",
                    step.status === "complete"
                      ? "bg-primary"
                      : "bg-border",
                  )}
                />
              )}
            </div>

            <div
              className={cn(
                "min-w-0",
                orientation === "horizontal" ? "mt-2" : "flex-1",
              )}
            >
              <div
                data-slot="stepper-label"
                className={cn(
                  "text-sm font-medium",
                  step.status === "upcoming" && "text-muted-foreground",
                )}
              >
                {step.label}
              </div>
              {step.description && (
                <div
                  data-slot="stepper-description"
                  className="text-caption text-muted-foreground"
                >
                  {step.description}
                </div>
              )}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export { Stepper }
