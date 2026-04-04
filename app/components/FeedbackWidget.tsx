"use client";

import { useState, useRef, useEffect } from "react";
import { useAction, useMutation } from "convex/react";
import { useUser } from "@clerk/nextjs";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";

interface FeedbackWidgetProps {
  automationId?: string;
  automationName?: string;
}

type State =
  | { phase: "idle" }
  | { phase: "open" }
  | { phase: "submitting" }
  | { phase: "done"; intent: "feedback" | "help"; response: string; ticketId?: string; subscribed: boolean };

export function FeedbackWidget({ automationId, automationName }: FeedbackWidgetProps) {
  const { isSignedIn } = useUser();
  const [state, setState] = useState<State>({ phase: "idle" });
  const [message, setMessage] = useState("");
  const [listening, setListening] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);

  const submitFeedback = useAction(api.feedback.submit);
  const subscribeMutation = useMutation(api.feedback.subscribe);

  // Focus textarea when panel opens
  useEffect(() => {
    if (state.phase === "open") {
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [state.phase]);

  if (!isSignedIn) return null;

  function open() {
    setState({ phase: "open" });
  }

  function close() {
    setState({ phase: "idle" });
    setMessage("");
    stopListening();
  }

  async function submit() {
    if (!message.trim() || state.phase === "submitting") return;
    setState({ phase: "submitting" });
    try {
      const result = await submitFeedback({
        message: message.trim(),
        automationId: automationId as Id<"automations"> | undefined,
        automationName,
        pageUrl: typeof window !== "undefined" ? window.location.href : "",
      });
      setState({
        phase: "done",
        intent: result.intent,
        response: result.response,
        ticketId: result.ticketId,
        subscribed: result.intent === "feedback", // auto-subscribed on submit
      });
    } catch (err: any) {
      setState({
        phase: "done",
        intent: "help",
        response: "Something went wrong. Please try again.",
        subscribed: false,
      });
    }
  }

  async function handleSubscribe(ticketId: string) {
    await subscribeMutation({ ticketId: ticketId as Id<"feedback"> });
    if (state.phase === "done") {
      setState({ ...state, subscribed: true });
    }
  }

  function startListening() {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = false;
    rec.onresult = (e: any) => {
      const transcript = e.results[0][0].transcript;
      setMessage((prev) => (prev ? prev + " " + transcript : transcript));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  }

  function stopListening() {
    recognitionRef.current?.stop();
    setListening(false);
  }

  function toggleVoice() {
    if (listening) stopListening();
    else startListening();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
    if (e.key === "Escape") close();
  }

  return (
    <>
      {/* Floating button */}
      {state.phase === "idle" && (
        <button
          onClick={open}
          className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-gray-900 text-white shadow-lg hover:bg-gray-700 transition-colors flex items-center justify-center"
          title="Feedback or help"
          aria-label="Open feedback"
        >
          <MessageIcon />
        </button>
      )}

      {/* Panel */}
      {state.phase !== "idle" && (
        <div className="fixed bottom-6 right-6 z-50 w-80 bg-white rounded-2xl shadow-xl border border-gray-200 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-4 pb-2">
            <span className="text-sm font-semibold text-gray-800">
              {state.phase === "done" && state.intent === "feedback"
                ? "Feedback received"
                : state.phase === "done"
                ? "Here to help"
                : "Ask anything"}
            </span>
            <button
              onClick={close}
              className="text-gray-400 hover:text-gray-600 transition-colors"
              aria-label="Close"
            >
              <CloseIcon />
            </button>
          </div>

          {/* Input phase */}
          {(state.phase === "open" || state.phase === "submitting") && (
            <div className="px-4 pb-4 flex flex-col gap-3">
              <p className="text-xs text-gray-500">
                Share feedback or ask a question — I'll figure out the rest.
              </p>
              <textarea
                ref={textareaRef}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={listening ? "Listening…" : "Type or speak…"}
                rows={3}
                disabled={state.phase === "submitting"}
                className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400 disabled:opacity-50"
              />
              <div className="flex items-center gap-2">
                {/* Voice button */}
                <button
                  onClick={toggleVoice}
                  disabled={state.phase === "submitting"}
                  className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${
                    listening
                      ? "bg-red-100 text-red-500 hover:bg-red-200"
                      : "bg-gray-100 text-gray-500 hover:bg-gray-200"
                  } disabled:opacity-40`}
                  title={listening ? "Stop recording" : "Voice input"}
                  aria-label="Voice input"
                >
                  <MicIcon listening={listening} />
                </button>

                <div className="flex-1" />

                {/* Submit */}
                <button
                  onClick={submit}
                  disabled={!message.trim() || state.phase === "submitting"}
                  className="px-3 py-1.5 rounded-lg bg-gray-900 text-white text-xs font-medium hover:bg-gray-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
                >
                  {state.phase === "submitting" ? (
                    <>
                      <SpinnerIcon />
                      Sending…
                    </>
                  ) : (
                    <>
                      Send
                      <span className="text-gray-400 text-[10px]">⌘↵</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          )}

          {/* Done phase */}
          {state.phase === "done" && (
            <div className="px-4 pb-4 flex flex-col gap-3">
              {/* Intent badge */}
              <span
                className={`self-start text-[10px] font-medium px-2 py-0.5 rounded-full ${
                  state.intent === "feedback"
                    ? "bg-blue-50 text-blue-600"
                    : "bg-green-50 text-green-600"
                }`}
              >
                {state.intent === "feedback" ? "Ticket created" : "Help"}
              </span>

              {/* Response */}
              <p className="text-sm text-gray-700 leading-relaxed">{state.response}</p>

              {/* Subscribe / send another */}
              <div className="flex items-center gap-2 pt-1">
                {state.intent === "feedback" && state.ticketId && (
                  <button
                    onClick={() => handleSubscribe(state.ticketId!)}
                    disabled={state.subscribed}
                    className="text-xs text-blue-600 hover:text-blue-700 disabled:text-gray-400 disabled:cursor-default transition-colors"
                  >
                    {state.subscribed ? "✓ Subscribed" : "Subscribe for updates"}
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => {
                    setMessage("");
                    setState({ phase: "open" });
                  }}
                  className="text-xs text-gray-400 hover:text-gray-600 transition-colors"
                >
                  Send another
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function MessageIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function MicIcon({ listening }: { listening: boolean }) {
  return listening ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="6" y="4" width="4" height="16" rx="2" />
      <rect x="14" y="4" width="4" height="16" rx="2" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
