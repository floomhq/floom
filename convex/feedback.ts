import { action, internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

// Submit feedback or a help question. Calls Gemini to classify + respond.
export const submit = action({
  args: {
    message: v.string(),
    automationId: v.optional(v.id("automations")),
    automationName: v.optional(v.string()),
    pageUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{
    intent: "feedback" | "help";
    response: string;
    ticketId?: string;
  }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY not configured");

    const orgId = (identity as any).org_id ?? identity.subject;
    const clerkUserId = identity.subject;

    const contextLine = args.automationName
      ? `The user is currently viewing an automation called "${args.automationName}".`
      : "The user is on the floom platform (no specific automation context).";

    const systemPrompt = `You are a smart support agent for Floom, an AI automation platform that lets users deploy Python scripts as live web apps with a UI.

${contextLine}

Classify the user message into one of two intents:
- "feedback": a bug report, feature request, complaint, or general product feedback
- "help": a question about how to use the platform, what something means, or how to navigate

Then respond appropriately:
- For "feedback": acknowledge it warmly, confirm you've logged a ticket, and tell them they can subscribe for updates. Keep it under 2 sentences.
- For "help": answer clearly and concisely. If relevant, mention where in the UI to find the thing. Keep it under 3 sentences.

Reply ONLY with valid JSON in this exact format:
{"intent": "feedback" | "help", "response": "your response here"}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [{ text: `System: ${systemPrompt}\n\nUser message: ${args.message}` }],
            },
          ],
          generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Gemini error: ${err}`);
    }

    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```json?\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed: { intent: "feedback" | "help"; response: string };
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { intent: "help", response: raw };
    }

    const intent = parsed.intent === "feedback" ? "feedback" : "help";
    const response = parsed.response ?? "Got it!";

    let ticketId: string | undefined;
    if (intent === "feedback") {
      ticketId = await ctx.runMutation(internal.feedback.insertTicket, {
        orgId,
        clerkUserId,
        message: args.message,
        agentResponse: response,
        automationId: args.automationId,
        automationName: args.automationName,
        pageUrl: args.pageUrl,
      });
    }

    return { intent, response, ticketId };
  },
});

// Internal mutation to insert a feedback ticket.
export const insertTicket = internalMutation({
  args: {
    orgId: v.string(),
    clerkUserId: v.string(),
    message: v.string(),
    agentResponse: v.string(),
    automationId: v.optional(v.id("automations")),
    automationName: v.optional(v.string()),
    pageUrl: v.string(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("feedback", {
      orgId: args.orgId,
      clerkUserId: args.clerkUserId,
      message: args.message,
      agentResponse: args.agentResponse,
      automationId: args.automationId,
      automationName: args.automationName,
      pageUrl: args.pageUrl,
      status: "open",
      subscribers: [args.clerkUserId],
      createdAt: Date.now(),
    });
    return id;
  },
});

// Subscribe to a feedback ticket.
export const subscribe = mutation({
  args: { ticketId: v.id("feedback") },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthorized");
    const ticket = await ctx.db.get(args.ticketId);
    if (!ticket) throw new Error("Ticket not found");
    const already = ticket.subscribers.includes(identity.subject);
    if (!already) {
      await ctx.db.patch(args.ticketId, {
        subscribers: [...ticket.subscribers, identity.subject],
      });
    }
  },
});
