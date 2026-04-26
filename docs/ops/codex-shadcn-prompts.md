# Codex prompt templates for Shadcn workflow

Codex CLI doesn't have skill-loading like Claude Code. Use these prompt templates when consulting codex for Shadcn-related tasks (review, scaffolding, theming).

For Claude Code, use the `/shadcn` skill at `~/.claude/skills/shadcn/SKILL.md` instead — it's auto-loaded.

For Clawdbot (WhatsApp), the same `/shadcn` skill is mirrored at `/opt/clawdbot/data/skills/shadcn/SKILL.md`.

---

## Template 1: Codex review of a Shadcn component for Floom theme adherence

Use when you have a Shadcn-scaffolded component diff and want codex's brutally honest take on whether it'll ship at saaspo-quality or look like a Vercel template.

```bash
codex review "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/. Stay focused on repository code only.

Review the Shadcn-themed component diff on this branch. Floom's design tokens are locked in apps/web/src/styles/wireframe.css. The bar is saaspo-quality (saaspo.com curated SaaS gallery — Linear / Vercel / Resend / Supabase level). Anti-patterns are documented in /root/.claude/skills/shadcn/SKILL.md (or ARCHITECTURE-DECISIONS.md ADR-017).

Brutal honest pass on:
1. Does the component actually use Floom's --bg / --card / --ink / --muted / --line / --accent tokens, or is it still on Shadcn's slate/zinc defaults?
2. Is border-radius 16/20px (Floom canon) or 6/8 (Shadcn default)?
3. Is shadow virtually-invisible (0 1px 0 rgba(17,24,39,0.02)) or Shadcn's shadow-sm?
4. Is Inter heavy 800 used on display text, or still Shadcn's default?
5. Any anti-patterns: DM Serif Display, pure-black backgrounds, decorative gradients, emojis, text-in-circles for logos, red asterisks?
6. Saaspo-test: would Linear / Vercel / Resend / Supabase ship this exact component as-is?

Pass/fail gate. If fail, list every override needed." --base origin/main -c 'model_reasoning_effort="high"' --enable web_search_cached
```

---

## Template 2: Codex consult for picking which Shadcn primitives to use

Use when you have a UI surface and want codex to map it to specific Shadcn primitives (vs keep custom).

```bash
codex exec "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/.

Floom UI surface to design: <DESCRIBE THE SURFACE HERE — e.g., a sharing modal with 4 visibility radios + invitee list>.

Per ADR-017 in docs/ARCHITECTURE-DECISIONS.md:
- ADOPT Shadcn for commodity primitives: Dialog, Tabs, Dropdown, cmdk, sonner, Popover, vaul Sheet, Select, Switch/Checkbox/Radio
- KEEP custom for Floom-voice: HeroDemo, output renderer, hero metric tile, app cards, sharing visibility ladder, agent-tokens display, studio rail

Tell me:
1. Which parts of this surface map to Shadcn primitives (cite exact components)
2. Which parts stay custom + why
3. Specific theme-token overrides needed (--accent, radius, shadow, font)
4. Bundle-size impact estimate
5. Any non-obvious Shadcn quirks that fight Floom's existing wireframe.css system" -C /root/floom -s read-only -c 'model_reasoning_effort="medium"'
```

---

## Template 3: Codex challenge — break a Shadcn-themed component

Use when you want codex to find edge cases (a11y, focus traps, mobile, RTL, dark mode) in a Shadcn component before merge.

```bash
codex exec "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/.

Adversarial review of the Shadcn-themed component on this branch. Find every way it breaks. Specifically:

- Focus trap escapes (esc key, click-outside, tab cycling)
- Keyboard navigation (arrow keys in dropdowns/tabs, home/end, page-up/down)
- Screen-reader announcements (aria-live, aria-expanded, aria-controls)
- Mobile breakpoints (375px viewport, touch targets ≥44px, no horizontal scroll)
- RTL layout (text direction, icon orientation)
- Dark mode (Floom is light-only today but components shouldn't break if dark gets added later)
- Reduced motion (prefers-reduced-motion respect)
- Concurrent state (rapid open/close, race conditions)
- Style conflicts with apps/web/src/styles/wireframe.css globals (specificity wars, !important needed?)

No compliments. Just the breakage." -C /root/floom -s read-only -c 'model_reasoning_effort="high"'
```

---

## Template 4: Codex codemod for inline-style → Tailwind utility migration

Used during the v1.1 long-tail migration of 2,519 inline-style hits. Codex generates a codemod for one file or a class of files at a time.

```bash
codex exec "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/.

Generate a codemod that converts inline style props in <FILE OR DIRECTORY> from React inline-style objects (style={{...}}) to Tailwind utility classes, using Floom's tailwind.config.js theme tokens.

Constraints:
- Map exact pixel values to nearest Tailwind utility (or arbitrary value if no match)
- Preserve dynamic styles (style={{ width: someValue }}) — leave as-is, don't convert
- Color tokens map to Floom's --bg, --card, --ink, --muted, --line, --accent (already in tailwind config)
- Output the codemod as a single TypeScript jscodeshift script
- After codemod: produce a screenshot diff for visual regression check

Do NOT run the codemod on the full repo — output the script + a 3-file dry-run example." -C /root/floom -s read-only -c 'model_reasoning_effort="high"'
```

---

## Saaspo reference fetcher (Claude Code, NOT codex)

For pulling design references from saaspo.com, use the `/saaspo` skill in Claude Code. Codex CLI doesn't have web-browse depth that matches Claude Code's WebFetch + reasoning, so saaspo lookups go through Claude.

If you must use codex for it, prepend this filesystem boundary + browse hint:

```bash
codex exec "IMPORTANT: Do NOT read or execute any files under ~/.claude/, ~/.agents/, .claude/skills/, or agents/.

Use --enable web_search_cached to look up saaspo.com curated examples for <SURFACE TYPE — landing / pricing / dashboard / sign-up>. List 5 references with site URL + 1-line takeaway each. Identify 3 recurring patterns. Recommend 3 specific moves to apply to Floom's <SURFACE NAME>." -C /root/floom -s read-only --enable web_search_cached -c 'model_reasoning_effort="medium"'
```

---

## When to use codex vs Claude `/shadcn` skill

| Task | Tool |
|---|---|
| Scaffolding a new Shadcn component for Floom | Claude `/shadcn` skill (uses Shadcn MCP) |
| Theming overrides + Floom-token mapping | Claude `/shadcn` skill |
| Saaspo reference lookup + grading | Claude `/saaspo` skill (uses WebFetch) |
| Brutal review of a Shadcn diff before merge | **Codex** Template 1 above |
| Adversarial / accessibility / breakage hunt | **Codex** Template 3 above |
| Inline-style → Tailwind codemod generation | **Codex** Template 4 above |
| Cross-model second opinion on a design call | **Codex** Template 2 above |

The split is the same as the labor split memory rule: Claude for UI/CSS/copy/wireframe; codex for adversarial/correctness/codemods.

## Cross-reference

- `/shadcn` skill: `~/.claude/skills/shadcn/SKILL.md`
- `/saaspo` skill: `~/.claude/skills/saaspo/SKILL.md`
- ADR-017: `/root/floom/docs/ARCHITECTURE-DECISIONS.md`
- Shadcn MCP server: configured in `~/.claude/settings.json` mcpServers as `shadcn: npx shadcn@latest mcp`
