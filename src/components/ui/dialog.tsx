"use client"

import * as React from "react"
import { useTranslations } from "next-intl"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  // No `data-slot` here ON PURPOSE. Triggers are rendered via `render={<Button/>}`
  // (csv-export-dialog, contact-form-dialog, …). base-ui merges a trigger `data-slot`
  // into the rendered Button NON-DETERMINISTICALLY across SSR vs hydration, producing a
  // `data-slot="dialog-trigger"` (server) ⇄ `data-slot="button"` (client) hydration
  // mismatch. Pinning the slot at the Button layer (button.tsx) does not defeat it
  // because base-ui resolves the trigger's slot last on the server. The trigger slot is
  // targeted by nothing in the codebase (verified — only the unrelated `refund-dialog-
  // trigger` test id matches that substring), so omitting it removes the conflict at the
  // source: the rendered element keeps only the Button's deterministic `data-slot="button"`.
  return <DialogPrimitive.Trigger {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  // No `data-slot` — same base-ui render-prop hydration mismatch as DialogTrigger:
  // DialogClose is used with `render={<Button/>}` (e.g. invite-user-dialog), where a
  // trigger/close `data-slot` merges into the Button non-deterministically SSR vs CSR.
  // The slot is targeted by nothing, so omit it (the rendered Button keeps "button").
  // The built-in close in DialogContent below ALSO renders via `render={<Button/>}`, so it
  // likewise omits `data-slot` for the same SSR/CSR-merge reason (not because it isn't a Button).
  return <DialogPrimitive.Close {...props} />
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 duration-[var(--modal-duration)] motion-reduce:duration-0 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
}) {
  const tButtons = useTranslations("buttons")
  return (
    <DialogPortal>
      <DialogOverlay
        style={{
          backgroundColor: `color-mix(in oklch, black calc(var(--modal-backdrop-opacity) * 100%), transparent)`,
        }}
      />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        // Inline style required: Tailwind v4 arbitrary utilities resolve at build time and
        // cannot consume a runtime CSS custom property for animation-timing-function.
        style={{ animationTimingFunction: 'var(--modal-easing)' }}
        className={cn(
          // Default max-width sized for form dialogs; callers override via className for sm/lg use cases.
          "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-[var(--card-radius)] bg-popover p-[var(--card-padding)] text-sm text-popover-foreground shadow-[var(--card-shadow)] ring-1 ring-foreground/10 duration-[var(--modal-duration)] motion-reduce:duration-0 outline-none sm:max-w-[var(--modal-max-width-md)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            // No `data-slot` — this built-in close uses `render={<Button/>}`, the same
            // base-ui render-prop path that mismatches `data-slot` SSR vs CSR (see the
            // DialogClose wrapper above). The Button keeps its deterministic "button" slot.
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">{tButtons("close")}</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-[var(--card-padding)] -mb-[var(--card-padding)] flex flex-col-reverse gap-2 rounded-b-[var(--card-radius)] border-t bg-muted/50 p-[var(--card-padding)] sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "font-heading text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
