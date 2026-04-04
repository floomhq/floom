# Floom Discovery Call Script

## Part 1: Discovery Questions (10 min)

**Open:** "We're building floom, the production layer for AI scripts. I want to understand your world before I show you anything."

### Block 1: Their World (3 min)

1. **What do you do day to day?**
   - Let them talk. Don't steer. Understand their role and who they serve.

2. **Where does automation / AI fit into your work right now?**
   - Are they building tools? Using them? Both?
   - For themselves, their team, or clients?

3. **What tools are you using?**
   - Python / n8n / Make / Zapier / custom code?
   - Claude Code, Cursor, Lovable, Supabase?
   - Follow up: "Are you happy with that setup?"

### Block 2: The Pain (4 min)

4. **When you build something that works, what happens next? How does it get to the people who use it?**
   - This reveals the deployment gap. Listen for: "I send them a link," "I deploy on Vercel," "I just run it on my laptop."

5. **What breaks? What goes wrong?**
   - API keys expire? Staging vs prod mistakes? No monitoring?
   - "How do you know when something stops working?"

6. **How long does it take you to go from 'it works' to 'it's running in production'?**
   - Minutes? Hours? Days?
   - "What's the bottleneck?"

7. **Who are the end users of what you build? How technical are they?**
   - Clients? Ops team? Non-technical stakeholders?
   - "Do they ever interact with the tool directly, or does everything go through you?"

### Block 3: Deeper Signals (3 min)

8. **If you could mass-produce tools at zero deployment cost, what would you build first?**
   - Reveals unmet demand. The tools they haven't built because deployment is too expensive.

9. **What have you tried and stopped using? Why?**
   - Make fatigue, n8n complexity, Zapier limitations. Understand why things fail.

10. **How do you stay up to date? Where do you learn about new tools?**
    - YouTube, Twitter/X, LinkedIn, Reddit, word of mouth?
    - Tells you where to reach more people like them.

11. **What would need to be true for you to adopt a new tool right now?**
    - Reliability? Price? Integration with existing stack? 5-min setup?
    - This is the buying criteria.

**Listen for throughout:**
- Google Sheets as DB (came up in 3/5 interviews)
- Staging vs prod concerns (4/5)
- Guardrails / HITL needs (3/5)
- White-label / client-facing UI (agency signal)
- "Too many tools" fatigue (adoption blocker)

---

## Part 2: Demo (optional, if time)

**Transition:** "I have a quick demo, about 5 minutes. Do you have time, or should we schedule a follow-up?"

If yes:

**Minute 1 - The script**
- Show a simple Python script (e.g. invoice generator or data lookup)
- `from floom import app`, `@app.action`, `floom.yaml`
- "This is all you write. floom handles the rest."

**Minute 2 - Deploy**
- `floom deploy` (or GitHub push)
- Show it go live: API endpoint, auto-generated UI, health check
- "Live. API, UI, monitoring. No Docker, no CI/CD."

**Minute 3 - The dashboard**
- Deployed tool in the dashboard
- Activity log, status, last run
- "Your clients / team see this. Not a terminal."

**Minute 4-5 - Their reaction**
- "First reaction?"
- "Would this replace something or add to it?"
- "What's missing for you to actually use this?"

---

## Part 3: Close (1 min)

1. **"Who else on your team would care about this?"**
   - Get names if possible.

2. **"Can I follow up in 2 weeks with [the thing they said was missing]?"**
   - Concrete next step. Not "let's stay in touch."

3. **If no demo:** "I'll send you a 2-min video of the demo. Can I get your honest feedback async?"

---

## After the Call

- [ ] Write up notes in `user-interviews/YYYY-MM-DD-firstname-lastname.md`
- [ ] Add new feature requests to `features/ROADMAP.md` (check for duplicates)
- [ ] Update `todos/TODO.md` with follow-up actions
- [ ] If "yes I'd use this" - add to waitlist/pilot list
- [ ] If no demo - send demo video within 24h
