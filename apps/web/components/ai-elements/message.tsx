"use client";

// Local AI Elements message primitives.

import type { ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

type MessageRole = "user" | "assistant" | "system";

export function Message({
  from,
  className,
  ...props
}: ComponentProps<"div"> & { from: MessageRole }) {
  return (
    <div
      data-slot="message"
      data-role={from}
      className={cn(
        "group/message flex w-full min-w-0 flex-col gap-1.5",
        from === "user" ? "items-end" : "items-start",
        className,
      )}
      {...props}
    />
  );
}

export function MessageContent({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-content"
      className={cn("min-w-0 max-w-full", className)}
      {...props}
    />
  );
}

export function MessageResponse({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-response"
      className={cn("min-w-0 text-sm leading-relaxed", className)}
      {...props}
    />
  );
}

export function MessageActions({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="message-actions"
      className={cn(
        "flex items-center gap-1 opacity-100 transition-opacity duration-150",
        className,
      )}
      {...props}
    />
  );
}

export function MessageAction({
  label,
  tooltip,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & { label: string; tooltip?: string }) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={label}
              title={label}
              className={cn("text-muted-foreground hover:text-foreground", className)}
              {...props}
            />
          }
        >
          {children}
        </TooltipTrigger>
        <TooltipContent>{tooltip ?? label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
