import { internalAction } from "./_generated/server";
import { v } from "convex/values";

export const sendFailureEmail = internalAction({
  args: {
    toEmail: v.string(),
    automationName: v.string(),
    automationId: v.id("automations"),
    errorType: v.string(),
    error: v.string(),
  },
  handler: async (_ctx, args) => {
    const resendKey = process.env.RESEND_API_KEY;
    if (!resendKey) return; // Email not configured — skip silently

    const { Resend } = await import("resend");
    const resend = new Resend(resendKey);

    const platformUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://yourplatform.com";
    const automationUrl = `${platformUrl}/a/${args.automationId}`;

    await resend.emails.send({
      from: "Floom <noreply@yourplatform.com>",
      to: args.toEmail,
      subject: `Scheduled run failed: ${args.automationName}`,
      html: `
        <p>Your scheduled automation <strong>${args.automationName}</strong> failed.</p>
        <p><strong>Error type:</strong> ${args.errorType}</p>
        <p><strong>Error:</strong> ${args.error}</p>
        <p><a href="${automationUrl}">View run history →</a></p>
        <p>To fix: run <code>/floom fix ${automationUrl}</code> in Claude Code.</p>
      `,
    });
  },
});
