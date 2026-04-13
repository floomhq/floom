import { create } from 'zustand';
import type {
  ActionSpec,
  AppDetail,
  AssistantTurnState,
  ChatTurn,
  InlineTemplateId,
  PickResult,
  RunRecord,
} from '../lib/types';
import * as api from '../api/client';

interface ChatState {
  threadId: string | null;
  turns: ChatTurn[];
  currentApp: AppDetail | null; // full manifest for sidebar
  sidebarOpen: boolean;
  isSubmitting: boolean;

  // actions
  init(threadId?: string): Promise<void>;
  submitPrompt(prompt: string): Promise<void>;
  submitPillPrompt(text: string, templateId: InlineTemplateId): void;
  expandToInputs(turnIndex: number, app: PickResult, actionSpec: ActionSpec, action: string): void;
  updateInput(turnIndex: number, name: string, value: unknown): void;
  runTurn(turnIndex: number): Promise<void>;
  openSidebar(app: AppDetail): void;
  closeSidebar(): void;
  iterate(lastTurnIndex: number, prompt: string): Promise<void>;
  reset(): void;
}

function makeTurnId(): string {
  return 'turn_' + Math.random().toString(36).slice(2, 12);
}

export const useChatStore = create<ChatState>((set, get) => ({
  threadId: null,
  turns: [],
  currentApp: null,
  sidebarOpen: false,
  isSubmitting: false,

  async init(threadId) {
    if (threadId) {
      set({ threadId });
    } else {
      // Lazy: create a client-side id, actually create on first turn.
      const id = 'thr_' + Math.random().toString(36).slice(2, 14);
      set({ threadId: id, turns: [] });
    }
  },

  async submitPrompt(prompt) {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    const { threadId, turns } = get();
    const tid = threadId || 'thr_' + Math.random().toString(36).slice(2, 14);

    const userTurn: ChatTurn = {
      id: makeTurnId(),
      kind: 'user',
      text: trimmed,
    };
    const assistantTurn: ChatTurn = {
      id: makeTurnId(),
      kind: 'assistant',
      state: { phase: 'streaming', app: { slug: '', name: '...', description: '', category: null, icon: null, confidence: 0 }, runId: '', logs: [] } satisfies AssistantTurnState,
    };

    // Optimistically add the user turn; assistant shows a loading shimmer.
    set({
      threadId: tid,
      turns: [
        ...turns,
        userTurn,
        { ...assistantTurn, state: { phase: 'error', message: '' } }, // placeholder
      ],
      isSubmitting: true,
    });

    try {
      // Persist user turn.
      api.saveTurn(tid, 'user', { text: trimmed }).catch(() => {
        // non-blocking
      });

      // Pick the best app.
      const { apps } = await api.pickApps(trimmed, 3);
      if (apps.length === 0 || apps[0].confidence < 0.25) {
        const fallback = await api.pickApps(trimmed, 3).catch(() => ({ apps: [] }));
        const state: AssistantTurnState = {
          phase: 'no-match',
          suggestions: fallback.apps.slice(0, 3),
        };
        const after = get().turns.slice();
        after[after.length - 1] = { id: assistantTurn.id, kind: 'assistant', state };
        set({ turns: after, isSubmitting: false });
        api.saveTurn(tid, 'assistant', state).catch(() => {});
        return;
      }

      const top = apps[0];
      // Parse inputs for the top app.
      const parsed = await api.parsePrompt(trimmed, top.slug);
      const state: AssistantTurnState = {
        phase: 'suggested',
        app: top,
        parsed,
        alternatives: apps.slice(1, 3),
      };
      const after = get().turns.slice();
      after[after.length - 1] = { id: assistantTurn.id, kind: 'assistant', state };
      set({ turns: after, isSubmitting: false });
      api.saveTurn(tid, 'assistant', state).catch(() => {});
    } catch (err) {
      const e = err as Error;
      const state: AssistantTurnState = {
        phase: 'error',
        message: e.message || 'Something went wrong',
      };
      const after = get().turns.slice();
      after[after.length - 1] = { id: assistantTurn.id, kind: 'assistant', state };
      set({ turns: after, isSubmitting: false });
    }
  },

  expandToInputs(turnIndex, app, actionSpec, action) {
    // Pull current parsed inputs from the suggested state if present.
    const turn = get().turns[turnIndex];
    if (!turn || turn.kind !== 'assistant') return;
    const inputs: Record<string, unknown> =
      turn.state.phase === 'suggested'
        ? { ...(turn.state.parsed?.inputs ?? {}) }
        : {};
    const state: AssistantTurnState = {
      phase: 'inputs',
      app,
      actionSpec,
      inputs,
      action,
    };
    const turns = get().turns.slice();
    turns[turnIndex] = { ...turn, state };
    set({ turns });
  },

  updateInput(turnIndex, name, value) {
    const turn = get().turns[turnIndex];
    if (!turn || turn.kind !== 'assistant' || turn.state.phase !== 'inputs') return;
    const turns = get().turns.slice();
    turns[turnIndex] = {
      ...turn,
      state: {
        ...turn.state,
        inputs: { ...turn.state.inputs, [name]: value },
      },
    };
    set({ turns });
  },

  async runTurn(turnIndex) {
    const turn = get().turns[turnIndex];
    if (!turn || turn.kind !== 'assistant' || turn.state.phase !== 'inputs') return;
    const { app, inputs, action } = turn.state;
    const threadId = get().threadId || undefined;

    try {
      const { run_id } = await api.startRun(app.slug, inputs, threadId, action);
      const streamState: AssistantTurnState = {
        phase: 'streaming',
        app,
        runId: run_id,
        logs: [],
      };
      const turns = get().turns.slice();
      turns[turnIndex] = { ...turn, state: streamState };
      set({ turns });

      // Subscribe to SSE stream.
      const close = api.streamRun(run_id, {
        onLog: (line) => {
          const current = get().turns[turnIndex];
          if (
            current &&
            current.kind === 'assistant' &&
            current.state.phase === 'streaming' &&
            current.state.runId === run_id
          ) {
            const nextTurns = get().turns.slice();
            nextTurns[turnIndex] = {
              ...current,
              state: {
                ...current.state,
                logs: [...current.state.logs, line.text],
              },
            };
            set({ turns: nextTurns });
          }
        },
        onStatus: (run: RunRecord) => {
          if (!['success', 'error', 'timeout'].includes(run.status)) return;
          const current = get().turns[turnIndex];
          if (!current || current.kind !== 'assistant') return;
          const nextTurns = get().turns.slice();
          nextTurns[turnIndex] = {
            ...current,
            state: { phase: 'done', app, run },
          };
          set({ turns: nextTurns });
          close();
        },
        onError: () => {
          // rely on polling fallback
        },
      });
    } catch (err) {
      const e = err as Error;
      const turns = get().turns.slice();
      turns[turnIndex] = {
        ...turn,
        state: { phase: 'error', message: e.message || 'Run failed to start' },
      };
      set({ turns });
    }
  },

  openSidebar(app) {
    set({ currentApp: app, sidebarOpen: true });
  },

  closeSidebar() {
    set({ sidebarOpen: false });
  },

  submitPillPrompt(text, templateId) {
    const { threadId, turns } = get();
    const tid = threadId || 'thr_' + Math.random().toString(36).slice(2, 14);
    const userTurn: ChatTurn = {
      id: makeTurnId(),
      kind: 'user',
      text,
    };
    const assistantTurn: ChatTurn = {
      id: makeTurnId(),
      kind: 'assistant',
      state: { phase: 'inline-template', templateId },
    };
    set({ threadId: tid, turns: [...turns, userTurn, assistantTurn] });
  },

  async iterate(_lastTurnIndex, prompt) {
    await get().submitPrompt(prompt);
  },

  reset() {
    set({ turns: [], threadId: null, sidebarOpen: false, currentApp: null });
  },
}));
