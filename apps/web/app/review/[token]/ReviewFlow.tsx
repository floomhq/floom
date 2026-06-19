"use client";

// Search Assistant Review Pack — public client review flow (sample-customer pilot).
// German UI, mobile-first, no phone-frame chrome, no demo bar. Four screens:
//   Gate (pack password) -> Identity (name/role) -> Review (job tabs, candidate
//   cards, 👍/🤔/👎, auto-save) -> Done.
// The token in the URL is the share secret; the pack password gates the body.
// Reviewer identity + the unlocked password persist in localStorage so a reload
// or a returning reviewer resumes without re-entering anything (contract:
// "localStorage for reviewer_key session"). Votes are idempotent upserts keyed
// by reviewer_key, so re-voting overwrites — safe to auto-save on every tap.

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Loader2 } from "lucide-react";
import { api } from "@/lib/api";
import { FloomMark } from "@/components/share/ShareCardShell";
import type {
  ReviewConsensus,
  ReviewPack,
  ReviewPackFeedbackResponse,
  ReviewPackPublicResponse,
  ReviewVerdict,
} from "@/lib/types";

// ── German strings ──────────────────────────────────────────────────────────
const VERDICT_LABEL: Record<ReviewVerdict, string> = {
  interested: "Interessiert",
  maybe: "Vielleicht",
  pass: "Nein",
};
const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  interested: "👍",
  maybe: "🤔",
  pass: "👎",
};
const NOTE_MAX = 240;

type Reviewer = { key: string; name: string; role: string };
type LocalVote = { verdict: ReviewVerdict; note: string | null };
type Screen = "loading" | "gate" | "identity" | "review" | "done";

// ── helpers ─────────────────────────────────────────────────────────────────
function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "reviewer";
}

function keyOf(jobId: string, candidateId: string): string {
  return `${jobId}|${candidateId}`;
}

function formatDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("de-DE", { day: "2-digit", month: "long", year: "numeric" });
}

function consensusMap(list: ReviewConsensus[]): Record<string, ReviewConsensus> {
  const out: Record<string, ReviewConsensus> = {};
  for (const c of list) out[keyOf(c.job_id, c.candidate_id)] = c;
  return out;
}

export function ReviewFlow({ token }: { token: string }) {
  const pwKey = `reviewpack.${token}.pw`;
  const reviewerKey = `reviewpack.${token}.reviewer`;

  const [screen, setScreen] = useState<Screen>("loading");
  const [pack, setPack] = useState<ReviewPack | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [consensus, setConsensus] = useState<Record<string, ReviewConsensus>>({});
  const [reviewer, setReviewer] = useState<Reviewer | null>(null);
  const [myVotes, setMyVotes] = useState<Record<string, LocalVote>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [activeJobId, setActiveJobId] = useState<string>("");

  // Gate form
  const [passwordInput, setPasswordInput] = useState("");
  const [gateError, setGateError] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);

  // Identity form
  const [nameInput, setNameInput] = useState("");
  const [roleInput, setRoleInput] = useState("");

  // Force the Workeros dark theme for this standalone client surface. The app
  // defaults to the light ("day") theme; the review pack is always presented in
  // the matte dark palette to match the design reference.
  useEffect(() => {
    const el = document.documentElement;
    const hadDark = el.classList.contains("dark");
    el.classList.add("dark");
    return () => {
      if (!hadDark) el.classList.remove("dark");
    };
  }, []);

  const mergeConsensus = useCallback((list: ReviewConsensus[]) => {
    if (!list?.length) return;
    setConsensus((prev) => ({ ...prev, ...consensusMap(list) }));
  }, []);

  const applyPack = useCallback((res: ReviewPackPublicResponse, pw: string | null) => {
    setPack(res.pack);
    setPassword(pw);
    setConsensus(consensusMap(res.consensus || []));
    setActiveJobId((current) => current || res.pack.jobs[0]?.id || "");
  }, []);

  const loadMyVotes = useCallback(
    async (rv: Reviewer, pw: string | null) => {
      try {
        const res: ReviewPackFeedbackResponse = await api.review.publicMyVotes(
          token,
          rv.key,
          pw ?? undefined,
        );
        const votes: Record<string, LocalVote> = {};
        const drafts: Record<string, string> = {};
        for (const v of res.my_votes || []) {
          const k = keyOf(v.job_id, v.candidate_id);
          votes[k] = { verdict: v.verdict, note: v.note ?? null };
          if (v.note) drafts[k] = v.note;
        }
        setMyVotes(votes);
        setNoteDrafts(drafts);
        mergeConsensus(res.consensus || []);
      } catch {
        // Non-fatal: reviewer can still vote; their prior votes just won't prefill.
      }
    },
    [token, mergeConsensus],
  );

  // Initial load: resume from localStorage. Try a (stored-password) GET; if the
  // pack isn't gated the no-password GET still succeeds and we skip the gate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let storedPw: string | null = null;
      let storedReviewer: Reviewer | null = null;
      try {
        storedPw = window.localStorage.getItem(pwKey);
        const raw = window.localStorage.getItem(reviewerKey);
        if (raw) storedReviewer = JSON.parse(raw) as Reviewer;
      } catch {
        /* localStorage unavailable — fall through to the gate */
      }
      try {
        const res = await api.review.publicGet(token, storedPw ?? undefined);
        if (cancelled) return;
        applyPack(res, storedPw ?? null);
        if (storedReviewer?.name) {
          setReviewer(storedReviewer);
          await loadMyVotes(storedReviewer, storedPw ?? null);
          if (!cancelled) setScreen("review");
        } else if (!cancelled) {
          setScreen("identity");
        }
      } catch {
        if (!cancelled) setScreen("gate");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const unlock = useCallback(
    async (pw: string) => {
      setUnlocking(true);
      setGateError(null);
      try {
        const res = await api.review.publicGet(token, pw);
        applyPack(res, pw);
        try {
          window.localStorage.setItem(pwKey, pw);
        } catch {
          /* ignore persistence failure */
        }
        setScreen("identity");
      } catch {
        setGateError("Passwort ist nicht korrekt oder der Link ist abgelaufen.");
      } finally {
        setUnlocking(false);
      }
    },
    [token, applyPack, pwKey],
  );

  const startReviewing = useCallback(async () => {
    const name = nameInput.trim();
    if (!name) return;
    const rv: Reviewer = { key: slugify(name), name, role: roleInput.trim() };
    setReviewer(rv);
    try {
      window.localStorage.setItem(reviewerKey, JSON.stringify(rv));
    } catch {
      /* ignore */
    }
    setScreen("review");
    await loadMyVotes(rv, password);
  }, [nameInput, roleInput, password, reviewerKey, loadMyVotes]);

  const saveVote = useCallback(
    async (jobId: string, candidateId: string, verdict: ReviewVerdict, note: string | null) => {
      if (!reviewer || !pack) return;
      const k = keyOf(jobId, candidateId);
      const prev = myVotes[k];
      setMyVotes((m) => ({ ...m, [k]: { verdict, note } }));
      setSaving((s) => ({ ...s, [k]: true }));
      try {
        const res = await api.review.publicFeedback(token, {
          password: password ?? undefined,
          job_id: jobId,
          candidate_id: candidateId,
          reviewer_key: reviewer.key,
          reviewer_name: reviewer.name,
          reviewer_role: reviewer.role || null,
          verdict,
          note,
        });
        mergeConsensus(res.consensus || []);
      } catch {
        setMyVotes((m) => {
          const next = { ...m };
          if (prev) next[k] = prev;
          else delete next[k];
          return next;
        });
        toast.error("Konnte nicht speichern. Bitte erneut versuchen.");
      } finally {
        setSaving((s) => ({ ...s, [k]: false }));
      }
    },
    [reviewer, pack, myVotes, token, password, mergeConsensus],
  );

  const handleVote = useCallback(
    (jobId: string, candidateId: string, verdict: ReviewVerdict) => {
      const k = keyOf(jobId, candidateId);
      // A note only attaches to "Vielleicht"/"Nein". Switching to "Interessiert"
      // clears it server-side.
      const note = verdict === "interested" ? null : (noteDrafts[k]?.trim() || null);
      void saveVote(jobId, candidateId, verdict, note);
    },
    [noteDrafts, saveVote],
  );

  const handleNoteCommit = useCallback(
    (jobId: string, candidateId: string) => {
      const k = keyOf(jobId, candidateId);
      const vote = myVotes[k];
      if (!vote || vote.verdict === "interested") return;
      const note = noteDrafts[k]?.trim() || null;
      if ((note ?? "") === (vote.note ?? "")) return;
      void saveVote(jobId, candidateId, vote.verdict, note);
    },
    [myVotes, noteDrafts, saveVote],
  );

  const activeJob = useMemo(
    () => pack?.jobs.find((j) => j.id === activeJobId) ?? pack?.jobs[0] ?? null,
    [pack, activeJobId],
  );

  const jobProgress = useCallback(
    (jobId: string) => {
      const job = pack?.jobs.find((j) => j.id === jobId);
      if (!job) return { done: 0, total: 0 };
      const done = job.candidates.filter((c) => myVotes[keyOf(jobId, c.id)]).length;
      return { done, total: job.candidates.length };
    },
    [pack, myVotes],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (screen === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--ink-soft)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (screen === "gate") {
    return (
      <GateScreen
        error={gateError}
        unlocking={unlocking}
        value={passwordInput}
        onChange={setPasswordInput}
        onSubmit={() => passwordInput.trim() && void unlock(passwordInput.trim())}
        expiresAt={pack?.meta.expires_at}
      />
    );
  }

  if (screen === "identity") {
    return (
      <IdentityScreen
        pack={pack}
        name={nameInput}
        role={roleInput}
        onName={setNameInput}
        onRole={setRoleInput}
        onPick={(s) => {
          setNameInput(s.name);
          setRoleInput(s.role ?? "");
        }}
        onStart={() => void startReviewing()}
      />
    );
  }

  if (!pack || !activeJob || !reviewer) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--bg)] text-[var(--ink-soft)]">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (screen === "done") {
    return (
      <DoneScreen
        pack={pack}
        reviewer={reviewer}
        myVotes={myVotes}
        onBack={() => setScreen("review")}
      />
    );
  }

  const active = jobProgress(activeJob.id);

  return (
    <div className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      {/* Header */}
      <header className="sticky top-0 z-20 [border-bottom:var(--bd-div)] bg-[var(--paper)]/95 backdrop-blur">
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <FloomMark size={18} label="" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-[var(--ink)]">
                {pack.client.name} · Review
              </div>
              <div className="truncate text-xs text-[var(--ink-soft)]">
                {activeJob.title} · {active.done}/{active.total}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setScreen("done")}
            className="shrink-0 rounded-[var(--radius-pill)] bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--solid-fg)] hover:opacity-90"
          >
            Fertig
          </button>
        </div>
        {/* progress */}
        <div className="h-1 w-full bg-[var(--bg-2)]">
          <div
            className="h-full bg-[var(--accent)] transition-[width] duration-300"
            style={{ width: `${active.total ? (active.done / active.total) * 100 : 0}%` }}
          />
        </div>
        {/* job tabs */}
        <div className="mx-auto flex max-w-3xl gap-2 overflow-x-auto px-4 py-2.5">
          {pack.jobs.map((job) => {
            const p = jobProgress(job.id);
            const isActive = job.id === activeJob.id;
            return (
              <button
                key={job.id}
                type="button"
                onClick={() => setActiveJobId(job.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-[var(--radius-pill)] px-3 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                    : "bg-[var(--bg-2)] text-[var(--ink-soft)] hover:text-[var(--ink)]"
                }`}
              >
                {job.title}
                <span className="opacity-70">
                  {p.done}/{p.total}
                </span>
              </button>
            );
          })}
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-24 pt-4">
        {/* Job context */}
        <section className="mb-4 rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">{activeJob.title}</h2>
          <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
            {[activeJob.location, activeJob.department].filter(Boolean).join(" · ")}
          </p>
          {activeJob.must_haves?.length > 0 && (
            <>
              <p className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
                Muss-Kriterien
              </p>
              <ul className="mt-1.5 space-y-1">
                {activeJob.must_haves.map((m, i) => (
                  <li key={i} className="flex gap-2 text-sm text-[var(--ink)]">
                    <span className="text-[var(--accent)]">·</span>
                    <span>{m}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {activeJob.coverage_note && (
            <p className="mt-3 rounded-[var(--radius-button)] bg-[var(--warning)]/12 px-3 py-2 text-xs text-[var(--warning)]">
              {activeJob.coverage_note}
            </p>
          )}
        </section>

        {/* Candidates */}
        <div className="space-y-3">
          {activeJob.candidates.map((cand) => {
            const k = keyOf(activeJob.id, cand.id);
            const vote = myVotes[k];
            const cons = consensus[k];
            const others = (cons?.chips || []).filter((chip) => chip.reviewer_name !== reviewer.name);
            const showNote = vote && vote.verdict !== "interested";
            return (
              <article
                key={cand.id}
                className={`rounded-[var(--radius-card)] bg-[var(--paper-2)] p-4 transition-shadow ${
                  vote ? "shadow-[inset_0_0_0_1px_var(--accent)]" : ""
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-sm font-semibold text-[var(--ink)]">
                      <span className="text-[var(--ink-soft)]">#{cand.rank}</span>
                      <span className="truncate">{cand.name}</span>
                    </div>
                    <div className="mt-0.5 truncate text-xs text-[var(--ink-soft)]">
                      {[cand.title, cand.company].filter(Boolean).join(" · ")}
                    </div>
                    {cand.location && (
                      <div className="mt-0.5 truncate text-xs text-[var(--ink-soft)]">{cand.location}</div>
                    )}
                  </div>
                  <span className="shrink-0 rounded-[var(--radius-button)] bg-[var(--success)]/15 px-2 py-1 text-xs font-bold text-[var(--success)]">
                    {cand.score}
                  </span>
                </div>

                {cand.why && (
                  <p className="mt-2.5 text-sm leading-relaxed text-[var(--ink)]">{cand.why}</p>
                )}

                {cand.linkedin && (
                  <a
                    href={cand.linkedin}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-[var(--accent)] hover:underline"
                  >
                    LinkedIn
                    <ExternalLink className="h-3 w-3" />
                  </a>
                )}

                {others.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {others.map((chip, i) => (
                      <span
                        key={i}
                        className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink-soft)]"
                      >
                        <span>{VERDICT_EMOJI[chip.verdict]}</span>
                        {chip.reviewer_name}
                      </span>
                    ))}
                  </div>
                )}

                {/* Votes */}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  {(["interested", "maybe", "pass"] as ReviewVerdict[]).map((v) => {
                    const selected = vote?.verdict === v;
                    const color =
                      v === "interested"
                        ? "var(--success)"
                        : v === "maybe"
                          ? "var(--warning)"
                          : "var(--negative)";
                    return (
                      <button
                        key={v}
                        type="button"
                        disabled={saving[k]}
                        onClick={() => handleVote(activeJob.id, cand.id, v)}
                        aria-pressed={selected}
                        aria-label={VERDICT_LABEL[v]}
                        className="flex items-center justify-center gap-1.5 rounded-[var(--radius-button)] px-2 py-2 text-[13px] font-medium transition-colors disabled:opacity-60"
                        style={
                          selected
                            ? {
                                background: `color-mix(in srgb, ${color} 18%, transparent)`,
                                color,
                                boxShadow: `inset 0 0 0 1px ${color}`,
                              }
                            : { background: "var(--bg-2)", color: "var(--ink)" }
                        }
                      >
                        <span aria-hidden>{VERDICT_EMOJI[v]}</span>
                        <span>{VERDICT_LABEL[v]}</span>
                      </button>
                    );
                  })}
                </div>

                {showNote && (
                  <div className="mt-2.5">
                    <textarea
                      value={noteDrafts[k] ?? ""}
                      maxLength={NOTE_MAX}
                      onChange={(e) => setNoteDrafts((d) => ({ ...d, [k]: e.target.value.slice(0, NOTE_MAX) }))}
                      onBlur={() => handleNoteCommit(activeJob.id, cand.id)}
                      placeholder="Kurze Notiz (optional)…"
                      rows={2}
                      className="w-full resize-none rounded-[var(--radius-button)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
                    />
                    <div className="mt-1 text-right text-[11px] text-[var(--ink-faint)]">
                      {(noteDrafts[k]?.length ?? 0)}/{NOTE_MAX}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </main>
    </div>
  );
}

// ── Screens ───────────────────────────────────────────────────────────────

function CenteredShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[var(--bg)] text-[var(--ink)]">
      <div className="flex flex-1 items-center justify-center px-5 py-10">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

function GateScreen({
  error,
  unlocking,
  value,
  onChange,
  onSubmit,
  expiresAt,
}: {
  error: string | null;
  unlocking: boolean;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  expiresAt?: string;
}) {
  const expiry = formatDate(expiresAt);
  return (
    <CenteredShell>
      <div className="mb-7 flex justify-center">
        <FloomMark size={24} />
      </div>
      <h1 className="text-xl font-semibold text-[var(--ink)]">Kandidaten-Review</h1>
      <p className="mt-1.5 text-sm text-[var(--ink-soft)]">
        Passwortgeschützter Zugang für Ihr Team.
      </p>

      <form
        className="mt-6"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <label className="mb-1.5 block text-xs font-medium text-[var(--ink-soft)]">Passwort</label>
        <input
          type="password"
          autoFocus
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Passwort aus der E-Mail"
          className="w-full rounded-[var(--radius-input)] bg-[var(--bg-2)] px-4 py-3 text-base text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        {error && <p className="mt-2 text-sm text-[var(--warning)]">{error}</p>}
        <button
          type="submit"
          disabled={unlocking || !value.trim()}
          className="mt-4 flex w-full items-center justify-center gap-2 rounded-[var(--radius-button)] bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-[var(--solid-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {unlocking && <Loader2 className="h-4 w-4 animate-spin" />}
          Weiter
        </button>
      </form>

      <div className="mt-7 rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4 text-xs leading-relaxed text-[var(--ink-soft)]">
        <p className="mb-1 font-medium text-[var(--ink)]">Datenschutzhinweis</p>
        Diese Profile werden ausschließlich zur Besetzung Ihrer offenen Stellen geteilt. Bitte
        leiten Sie den Link nicht weiter. Zugriff ist passwortgeschützt.
        {expiry ? ` Gültig bis ${expiry}.` : " Der Link ist zeitlich befristet."}
      </div>
    </CenteredShell>
  );
}

function IdentityScreen({
  pack,
  name,
  role,
  onName,
  onRole,
  onPick,
  onStart,
}: {
  pack: ReviewPack | null;
  name: string;
  role: string;
  onName: (v: string) => void;
  onRole: (v: string) => void;
  onPick: (s: { name: string; role?: string }) => void;
  onStart: () => void;
}) {
  const suggestions =
    pack?.reviewers_suggested && pack.reviewers_suggested.length > 0
      ? pack.reviewers_suggested
      : [{ name: "Vera", role: "Recruiting" }, { name: "Hendrik", role: "Gründer" }];

  return (
    <CenteredShell>
      <div className="mb-7 flex justify-center">
        <FloomMark size={24} />
      </div>
      <h1 className="text-xl font-semibold text-[var(--ink)]">Wer überprüft?</h1>
      <p className="mt-1.5 text-sm text-[var(--ink-soft)]">
        Damit Ihr Team sieht, wer welches Profil markiert hat. Kein Konto nötig.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {suggestions.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => onPick(s)}
            className={`rounded-[var(--radius-pill)] px-3 py-1.5 text-sm transition-colors ${
              name === s.name
                ? "bg-[var(--accent-soft)] text-[var(--accent)]"
                : "bg-[var(--bg-2)] text-[var(--ink-soft)] hover:text-[var(--ink)]"
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>

      <form
        className="mt-5"
        onSubmit={(e) => {
          e.preventDefault();
          onStart();
        }}
      >
        <label className="mb-1.5 block text-xs font-medium text-[var(--ink-soft)]">Ihr Name</label>
        <input
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="z. B. Vera"
          className="w-full rounded-[var(--radius-input)] bg-[var(--bg-2)] px-4 py-3 text-base text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <label className="mb-1.5 mt-3 block text-xs font-medium text-[var(--ink-soft)]">
          Rolle (optional)
        </label>
        <input
          value={role}
          onChange={(e) => onRole(e.target.value)}
          placeholder="z. B. Recruiting"
          className="w-full rounded-[var(--radius-input)] bg-[var(--bg-2)] px-4 py-3 text-base text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]"
        />
        <button
          type="submit"
          disabled={!name.trim()}
          className="mt-4 w-full rounded-[var(--radius-button)] bg-[var(--accent)] px-4 py-3 text-sm font-semibold text-[var(--solid-fg)] transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          Review starten
        </button>
      </form>
    </CenteredShell>
  );
}

function DoneScreen({
  pack,
  reviewer,
  myVotes,
  onBack,
}: {
  pack: ReviewPack;
  reviewer: Reviewer;
  myVotes: Record<string, LocalVote>;
  onBack: () => void;
}) {
  const picks: { name: string; job: string; verdict: ReviewVerdict }[] = [];
  let total = 0;
  for (const job of pack.jobs) {
    for (const cand of job.candidates) {
      const v = myVotes[keyOf(job.id, cand.id)];
      if (!v) continue;
      total += 1;
      if (v.verdict === "interested") {
        picks.push({ name: cand.name, job: job.title, verdict: v.verdict });
      }
    }
  }

  return (
    <CenteredShell>
      <div className="text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-[var(--success)]/20 text-2xl text-[var(--success)]">
          ✓
        </div>
        <h1 className="mt-4 text-xl font-semibold text-[var(--ink)]">Review abgeschlossen</h1>
        <p className="mt-1.5 text-sm text-[var(--ink-soft)]">
          Danke, {reviewer.name}. Ihre Auswahl wurde gespeichert ({total} bewertet).
        </p>
      </div>

      {picks.length > 0 && (
        <>
          <p className="mt-7 text-[11px] font-semibold uppercase tracking-wide text-[var(--ink-soft)]">
            Ihre Favoriten
          </p>
          <ul className="mt-2 overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-2)]">
            {picks.map((p, i) => (
              <li
                key={i}
                className="flex items-center justify-between gap-3 px-4 py-3 text-sm text-[var(--ink)] [&:not(:last-child)]:[border-bottom:var(--bd-div)]"
              >
                <span className="min-w-0">
                  <span className="mr-2">{VERDICT_EMOJI[p.verdict]}</span>
                  <span className="font-medium">{p.name}</span>
                </span>
                <span className="shrink-0 text-xs text-[var(--ink-soft)]">{p.job}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="mt-6 text-center text-xs text-[var(--ink-soft)]">
        Sie können jederzeit zurückkehren und Ihre Auswahl ändern.
      </p>
      <button
        type="button"
        onClick={onBack}
        className="mt-3 w-full rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-3 text-sm font-semibold text-[var(--ink)] hover:opacity-90"
      >
        Zurück zum Review
      </button>
    </CenteredShell>
  );
}
