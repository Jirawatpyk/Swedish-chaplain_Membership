import * as React from "react"
import { AlertCircle, Check } from "lucide-react"

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
 *   - status "error"     → destructive circle + AlertCircle icon
 *                          (F2 polish round 2: marks a step the user
 *                          must revisit after a final-submit validation
 *                          failure)
 *
 * Compact mode (`compact={true}`):
 *   - At viewport <sm (640px), step labels are hidden so 3-4 long
 *     non-Latin labels (e.g. Thai "ข้อมูลพื้นฐาน" / "สิทธิประโยชน์")
 *     don't overflow. Consumers should render a compact summary
 *     ("Step 2/4 — {label}") below the stepper in mobile breakpoints.
 *   - Defaults to false so existing consumers (F6 webhook-config-
 *     wizard) keep labels at all breakpoints.
 *
 * Accessibility:
 *   - The container exposes role=list and `aria-label` required.
 *   - The current step carries `aria-current="step"` so SR users can
 *     jump directly to it.
 *   - Connectors are `aria-hidden` decorative elements.
 *   - Error steps add `aria-invalid="true"` so SRs announce the
 *     validation state independently of the visual cue.
 */
export type StepperStatus = "complete" | "current" | "upcoming" | "error"

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
  /**
   * Hide step labels at viewport <sm (640px). Defaults to false.
   * Consumers using `compact` typically render their own compact
   * summary text below the stepper for mobile users.
   */
  compact?: boolean
}

function Stepper({
  steps,
  className,
  orientation = "horizontal",
  compact = false,
  ...props
}: StepperProps) {
  return (
    <ol
      data-slot="stepper"
      data-orientation={orientation}
      className={cn(
        "flex w-full",
        orientation === "horizontal"
          ? // F6 verify-fix (2026-05-13): gap-0 so connector lines from
            // adjacent steps meet without an 8px visual break. Labels
            // remain visually spaced because each <li> is `flex-1`
            // text-center — labels are centered within their slot, not
            // hard-anchored against the step boundary. Vertical
            // breathing room from the indicator block to the label
            // comes from the inner div's `mt-2` (8px) — sufficient
            // without horizontal gap.
            "flex-row items-start gap-0"
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
            aria-invalid={step.status === "error" ? "true" : undefined}
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
              {/*
                F6 verify-fix (2026-05-13): ALWAYS render both connectors
                in horizontal mode so every indicator sits flex-center
                within its <li>. Previously the first step had no BEFORE
                connector and the last step had no AFTER connector —
                first indicator anchored start, last indicator anchored
                end, labels (centered) no longer aligned vertically with
                their indicators. First-step BEFORE + last-step AFTER
                render as `bg-transparent` so they reserve flex space
                without drawing the line outside the wizard's first/
                last indicator. Combined with the parent `gap-0`, the
                middle connectors meet at <li> boundaries → visually
                continuous progression from step 1 indicator to last.
              */}
              {orientation === "horizontal" && (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    "h-px flex-1",
                    index === 0
                      ? "bg-transparent"
                      : step.status === "upcoming"
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
                  step.status === "error" &&
                    "border-destructive bg-destructive text-destructive-foreground",
                )}
              >
                {step.status === "complete" ? (
                  <Check aria-hidden="true" className="size-4" />
                ) : step.status === "error" ? (
                  <AlertCircle aria-hidden="true" className="size-4" />
                ) : (
                  <span aria-hidden="true">{index + 1}</span>
                )}
              </span>
              {orientation === "horizontal" && (
                <span
                  aria-hidden="true"
                  data-slot="stepper-connector"
                  className={cn(
                    "h-px flex-1",
                    isLast
                      ? "bg-transparent"
                      : step.status === "complete"
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
                // F2 polish round 2 — compact mode hides labels under
                // sm:640px so long non-Latin labels (Thai/Swedish) don't
                // overflow on mobile. Consumers render a compact summary
                // ("Step 2/4 — {label}") below the stepper for mobile.
                compact && orientation === "horizontal" && "hidden sm:block",
              )}
            >
              <div
                data-slot="stepper-label"
                className={cn(
                  "text-sm font-medium",
                  step.status === "upcoming" && "text-muted-foreground",
                  step.status === "error" && "text-destructive",
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
