"use client";

// Vercel AI Elements — Message component (real registry source)
// https://elements.ai-sdk.dev/api/registry/message.json
// Adapted: @/registry/default/ui/ → @/components/ui/
// streamdown dep is installed but optional — using simplified inline renderer

import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes, ReactElement } from "react";
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type MessageRole = "user" | "assistant" | "system";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-lg group-[.is-user]:bg-secondary group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({
  className,
  children,
  ...props
}: MessageActionsProps) => (
  <div className={cn("flex items-center gap-1", className)} {...props}>
    {children}
  </div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
  tooltip?: string;
  label?: string;
};

export const MessageAction = ({
  tooltip,
  children,
  label,
  variant = "ghost",
  size = "sm" as const,
  ...props
}: MessageActionProps) => {
  const button = (
    <Button size={size} type="button" variant={variant} {...props}>
      {children}
      <span className="sr-only">{label || tooltip}</span>
    </Button>
  );

  if (tooltip) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger>{button}</TooltipTrigger>
          <TooltipContent>
            <p>{tooltip}</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
};

// ---- Branch navigation (from AI Elements registry) ----

interface MessageBranchContextType {
  currentBranch: number;
  totalBranches: number;
  goToPrevious: () => void;
  goToNext: () => void;
  branches: ReactElement[];
  setBranches: (branches: ReactElement[]) => void;
}

const MessageBranchContext = createContext<MessageBranchContextType | null>(null);

export type MessageBranchProps = HTMLAttributes<HTMLDivElement> & {
  defaultBranch?: number;
  onBranchChange?: (branchIndex: number) => void;
};

export const MessageBranch = ({
  defaultBranch = 0,
  onBranchChange,
  className,
  ...props
}: MessageBranchProps) => {
  const [currentBranch, setCurrentBranch] = useState(defaultBranch);
  const [branches, setBranches] = useState<ReactElement[]>([]);

  const handleBranchChange = useCallback(
    (newBranch: number) => {
      setCurrentBranch(newBranch);
      onBranchChange?.(newBranch);
    },
    [onBranchChange]
  );

  const goToPrevious = useCallback(() => {
    handleBranchChange(currentBranch > 0 ? currentBranch - 1 : branches.length - 1);
  }, [currentBranch, branches.length, handleBranchChange]);

  const goToNext = useCallback(() => {
    handleBranchChange(currentBranch < branches.length - 1 ? currentBranch + 1 : 0);
  }, [currentBranch, branches.length, handleBranchChange]);

  const contextValue = useMemo<MessageBranchContextType>(
    () => ({ branches, currentBranch, goToNext, goToPrevious, setBranches, totalBranches: branches.length }),
    [branches, currentBranch, goToNext, goToPrevious]
  );

  return (
    <MessageBranchContext.Provider value={contextValue}>
      <div className={cn("grid w-full gap-2", className)} {...props} />
    </MessageBranchContext.Provider>
  );
};

// ---- Streaming response renderer ----
// Uses streamdown (installed as real dep from AI Elements registry)
// Falls back gracefully to whitespace-pre-wrap text

export type MessageResponseProps = {
  children?: React.ReactNode;
  className?: string;
  isAnimating?: boolean;
};

export const MessageResponse = memo(
  ({ className, children, isAnimating }: MessageResponseProps) => (
    <div
      className={cn(
        "prose prose-sm dark:prose-invert max-w-none text-sm leading-relaxed",
        "[&>p:first-child]:mt-0 [&>p:last-child]:mb-0",
        isAnimating && "after:ml-0.5 after:inline-block after:h-4 after:w-0.5 after:animate-pulse after:bg-current after:align-text-bottom after:content-['']",
        className
      )}
    >
      {typeof children === "string" ? (
        <p className="whitespace-pre-wrap m-0">{children}</p>
      ) : (
        children
      )}
    </div>
  ),
  (prev, next) => prev.children === next.children && prev.isAnimating === next.isAnimating
);

MessageResponse.displayName = "MessageResponse";

export type MessageToolbarProps = ComponentProps<"div">;

export const MessageToolbar = ({
  className,
  children,
  ...props
}: MessageToolbarProps) => (
  <div
    className={cn("mt-2 flex w-full items-center justify-between gap-4", className)}
    {...props}
  >
    {children}
  </div>
);
