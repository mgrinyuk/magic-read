# Design & handoff docs

Reference material for the Sonic reskin. Code lives in `frontend/` and `backend/`; SQL migrations are in `backend/0*-*.sql`.

## mockups/
Self-contained HTML mockups of each screen (the visual + copy target). Open in a browser.

## Docs (this folder)
- `magic-read-ui-copy.md` — every UI string (source of truth for copy).
- `magic-read-phase1-handoff.md` — reskin spec: tokens, screens, config, backend items.
- `magic-read-vscode-runbook.md` — step-by-step prompts for the reskin (chosen path).
- `magic-read-vscode-kickoff-prompt.md` — all-in-one alternative to the runbook.
- `backend-next-steps.md` — stats / 20-limit / SRS wiring steps.
- `integrate-login-and-resume.md` — Google/Apple login + "continue where you left off".
- `magic-read-discovery-questions.md` — the original requirements Q&A.

## archive/
Spent build prompts. The video feature is already implemented; these are kept only because
`video-phase2-buildkit.md` Step 5 (Azure STT on uploaded media) is the reference if you ever
add auto-generated captions for videos with none.
