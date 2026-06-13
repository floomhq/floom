import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ToolCard } from "@/lib/emily-chat-types";
import { Tool } from "@/components/ai-elements/tool";
import { getCardHref, getToolCardTitle } from "@/lib/useChatStream";
import { WorkerCreateCard } from "./WorkerCreateCard";
import { RunCard } from "./RunCard";
import { ConnectServiceCard } from "./ConnectServiceCard";
import { ApprovalCard } from "./ApprovalCard";
import { WorkerListCard } from "./WorkerListCard";
import { GenericToolCard } from "./GenericToolCard";

function renderCard(card: ToolCard) {
  switch (card.kind) {
    case "worker-create":
      return <WorkerCreateCard card={card} />;
    case "run":
      return <RunCard card={card} />;
    case "connect-service":
      return <ConnectServiceCard card={card} />;
    case "approval":
      return <ApprovalCard card={card} />;
    case "worker-list":
      return <WorkerListCard card={card} />;
    case "generic":
      return <GenericToolCard card={card} />;
    default:
      return null;
  }
}

function toolTitle(card: ToolCard): string {
  switch (card.kind) {
    case "generic":
      return card.title || card.toolName;
    case "run":
      return card.workerName || (card.toolName ? getToolCardTitle(card.toolName, card.status) : "Worker run");
    case "worker-create":
      return card.workerName;
    case "worker-list":
      return `Workers (${card.workers.length})`;
    case "connect-service":
      return card.connected ? card.label : `Connect ${card.label}`;
    case "runs-list":
      return `Runs (${card.runs.length})`;
    case "artifact":
      return card.name;
    default:
      return "Tool call";
  }
}

function toolIsError(card: ToolCard): boolean {
  return card.status === "failed" || card.status === "error" || card.status === "cancelled";
}

export function ToolCardRenderer({ card }: { card: ToolCard }) {
  const body = renderCard(card);
  if (!body) return null;
  if (card.kind === "approval") {
    return <div className="space-y-1">{body}</div>;
  }
  // #825: Emily's answers link to app pages as real router hrefs (links only —
  // no DOM access / page driving).
  const href = getCardHref(card);
  return (
    <div className="space-y-1">
      {card.kind === "generic" ? (
        body
      ) : (
        <Tool
          name={toolTitle(card)}
          args={card.args}
          result={card.result}
          isError={toolIsError(card)}
          callId={card.callId}
          status={card.status}
          duration={card.duration}
        >
          {body}
        </Tool>
      )}
      {href && (
        <Link
          href={href}
          className="inline-flex items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          Open in app <ArrowUpRight size={12} />
        </Link>
      )}
    </div>
  );
}
