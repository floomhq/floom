import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import type { ToolCard } from "@/lib/emily-chat-types";
import { getCardHref } from "@/lib/useChatStream";
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

export function ToolCardRenderer({ card }: { card: ToolCard }) {
  const body = renderCard(card);
  if (!body) return null;
  // #825: Emily's answers link to app pages as real router hrefs (links only —
  // no DOM access / page driving).
  const href = getCardHref(card);
  return (
    <div className="space-y-1">
      {body}
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
