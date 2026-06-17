# Kickoff prompt for the Claude extension in VS Code

Copy everything in the box below and paste it as your first message to Claude in the VS Code extension, with the repo open.

---

```
You're reskinning the Magic Read web app (vanilla HTML/CSS/JS frontend + Express/Supabase backend) into a new "Sonic" design, applying finalized copy, and making a few structural changes. This is a RESKIN, not a rewrite — preserve all existing functionality (Supabase auth, Stripe, Azure pronunciation scoring, Google TTS, translation, PDF export).

Read these files in the repo root first, they are the source of truth:
- magic-read-phase1-handoff.md  ← the full spec; follow it section by section
- magic-read-ui-copy.md          ← every UI string (final copy)
- The *-sonic.html mockups       ← the exact visual target (layout, components, colors)

Then work in this order, and STOP after each step to show me a git diff before moving on:

1. style.css — swap the :root palette to the Sonic tokens in handoff §2. Add Inter + Noto Sans SC fonts. Search/replace retired indigo vars (--brand, --brand-dark).
2. Global shell + bottom tab bar (Home/Read/Speak/Cards/Video) + magenta logo (handoff §3).
3. Onboarding (#screen-onboarding): remove the skill/level step entirely; add the trial-start screen; "Choose languages" (handoff §4).
4. Home dashboard — NEW screen: streak + 3 stat tiles + action grid + resume + usage meter (handoff §4, mockup home-dashboard-sonic.html). Stub the stats with placeholder data; I'll wire the backend counters separately.
5. Reader (#screen-main): reskin; word actions go in the click popover (pinyin·translation·save); add "Saved texts" to the toolbar; REMOVE grammar notes; add a word-ordering exercise.
6. Speaking: reskin; usage meter "{n}/20 left"; tone-feedback block using the standardized strings; reuse azure-pronunciation.js data.
7. Flashcards (#screen-flashcards): reskin; add SRS Again/Good/Easy; remove the example sentence; clean stray symbols from the translation; prompt "How well do you know it?".
8. Account menu: reskin; add Manage subscription + App language.
9. Calligraphy (#screen-writing) + Landing/hero: reskin only; landing headline "Laser-focus on your pronunciation."
10. Config in app.js: set userPlan.limits.pronunciationPerDay = 20 (was 10); update UPGRADE_MESSAGES to the §7 copy and show them as a dismissible modal at hard limits while keeping the inline usage meter on lite. Do NOT flip AZURE_PRONUNCIATION to true until I confirm the backend quota is 20.

Rules:
- Mobile-first: content max 700px centered on desktop, full-bleed under 720px.
- Don't touch backend billing/auth logic. Backend items (streak/word stats, SRS scheduling fields, per-activity progress, Google/Apple auth, FREE_DAILY_PRONUNCIATION_LIMIT=20) are listed in handoff §7 — flag them, but I'll handle backend separately unless I ask.
- Video feature is Phase 2 — skip it (hide or "coming soon" the Video tab).
- Keep diffs small and reviewable. Ask before introducing any new dependency or build step.

Start with step 1 and show me the diff.
```

---

### Tips while it works
- After each step, run the app and click through that screen before approving the diff.
- Commit per screen (e.g. `git commit -m "reskin: speaking screen"`) so you can roll back one screen without losing the rest.
- When you reach the backend items (§7), either point it at the backend with a follow-up prompt or hand them to your backend dev.
- If it drifts from a mockup, paste the relevant `*-sonic.html` and say "match this exactly."
