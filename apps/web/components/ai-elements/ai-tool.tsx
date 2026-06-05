"use client";

// Vercel AI Elements — Tool component (real registry source)
// https://elements.ai-sdk.dev/api/registry/tool.json
// Adapted: @/registry/default/ui/ → @/components/ui/
// This file exports the AI Elements compositional API (Tool, ToolHeader, ToolContent, ToolInput, ToolOutput)
// alongside the ToolState type.

import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  CheckCircleIcon,
  ChevronDownIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react";
import type { ComponentProps, ReactNode } from "react";

// ---- Types ----
export type ToolState =
  | "approval-requested"
  | "approval-responded"
  | "input-available"
  | "input-streaming"
  | "output-available"
  | "output-denied"
  | "output-error";

// ---- Status labels/icons (from AI Elements registry source) ----
const statusLabels: Record<ToolState, string> = {
  "approval-requested": "Awaiting Approval",
  "approval-responded": "Responded",
  "input-available": "Running",
  "input-streaming": "Pending",
  "output-available": "Completed",
  "output-denied": "Denied",
  "output-error": "Error",
};

const statusIcons: Record<ToolState, ReactNode> = {
  "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
  "input-available": <ClockIcon className="size-4 animate-pulse text-muted-foreground" />,
  "input-streaming": <CircleIcon className="size-4 text-muted-foreground" />,
  "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
  "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
  "output-error": <XCircleIcon className="size-4 text-red-600" />,
};

export const getStatusBadge = (status: ToolState) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {statusLabels[status]}
  </Badge>
);

// ---- Tool (root container) ----
export type AiToolProps = ComponentProps<typeof Collapsible>;

export const AiTool = ({ className, ...props }: AiToolProps) => (
  <Collapsible
    className={cn("group not-prose mb-2 w-full rounded-md border", className)}
    {...props}
  />
);

// ---- ToolHeader ----
export type ToolHeaderProps = {
  title?: string;
  className?: string;
  toolName?: string;
  state: ToolState;
};

export const ToolHeader = ({
  className,
  title,
  state,
  toolName,
  ...props
}: ToolHeaderProps) => (
  <CollapsibleTrigger
    className={cn(
      "flex w-full items-center justify-between gap-4 p-3",
      className
    )}
    {...props}
  >
    <div className="flex items-center gap-2">
      <WrenchIcon className="size-4 text-muted-foreground" />
      <span className="font-medium text-sm">{title ?? toolName ?? "Tool"}</span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

// ---- ToolContent ----
export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn("space-y-4 p-4 text-popover-foreground outline-none", className)}
    {...props}
  />
);

// ---- ToolInput ----
export type ToolInputProps = ComponentProps<"div"> & {
  input?: unknown;
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => (
  <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
    <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
      Parameters
    </h4>
    <div className="rounded-md bg-muted/50 p-3">
      <pre className="text-xs overflow-auto whitespace-pre-wrap">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  </div>
);

// ---- ToolOutput ----
export type ToolOutputProps = ComponentProps<"div"> & {
  output?: unknown;
  errorText?: string;
};

export const ToolOutput = ({
  className,
  output,
  errorText,
  ...props
}: ToolOutputProps) => {
  if (!(output || errorText)) {
    return null;
  }

  const outputStr =
    typeof output === "string" ? output : JSON.stringify(output, null, 2);

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? "Error" : "Result"}
      </h4>
      <div
        className={cn(
          "overflow-x-auto rounded-md p-3 text-xs",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {errorText && <div className="mb-2">{errorText}</div>}
        {output !== undefined && (
          <pre className="overflow-auto whitespace-pre-wrap">{outputStr}</pre>
        )}
      </div>
    </div>
  );
};
