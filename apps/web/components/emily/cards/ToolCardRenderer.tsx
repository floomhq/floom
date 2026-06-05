import type { ToolCard } from "@/lib/emily-chat-types";
import { WorkerCreateCard } from "./WorkerCreateCard";
import { RunCard } from "./RunCard";
import { ConnectServiceCard } from "./ConnectServiceCard";
import { ApprovalCard } from "./ApprovalCard";
import { WorkerListCard } from "./WorkerListCard";
import { GenericToolCard } from "./GenericToolCard";

export function ToolCardRenderer({ card }: { card: ToolCard }) {
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
