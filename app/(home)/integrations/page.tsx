import type { Metadata } from "next";
import { IntegrationsBody } from "./IntegrationsBody";

export const metadata: Metadata = {
  title: "Integrations — Floom",
  description:
    "Connect Floom to 1,000+ tools — Gmail, Google Calendar, Notion, HubSpot, Salesforce, GitHub, Linear, and hundreds more.",
};

export default function IntegrationsPage() {
  return <IntegrationsBody />;
}
