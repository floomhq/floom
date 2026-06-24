/** Landing channel kill-switches — Slack/WhatsApp off until explicitly enabled. */

export type LandingChannel = "slack" | "whatsapp" | "mcp";

function envEnabled(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

export function isSlackChannelEnabled(): boolean {
  return envEnabled("NEXT_PUBLIC_LANDING_CHANNEL_SLACK");
}

export function isWhatsAppChannelEnabled(): boolean {
  return envEnabled("NEXT_PUBLIC_LANDING_CHANNEL_WHATSAPP");
}

export function isLandingChannelEnabled(channel: LandingChannel): boolean {
  if (channel === "mcp") return true;
  if (channel === "slack") return isSlackChannelEnabled();
  return isWhatsAppChannelEnabled();
}

export function enabledLandingChannels(): LandingChannel[] {
  const channels: LandingChannel[] = [];
  if (isSlackChannelEnabled()) channels.push("slack");
  if (isWhatsAppChannelEnabled()) channels.push("whatsapp");
  channels.push("mcp");
  return channels;
}
