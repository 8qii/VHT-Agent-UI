# UI verification 12 October 2026

**12 Node checks + 12 Chromium browser checks PASS. No browser page errors.** UI served at `http://127.0.0.1:5173` (HTTP 200). The original integration DOCX is unchanged.

## Verified

- CR/LF/CRLF SSE framing, comment heartbeats, multiline data, byte-split UTF-8 Vietnamese.
- v2 reducer: snapshot reset, append/replace, nullable status, public progress; rejects cross-run frames and invalid sequence/version.
- REST numeric statuses; Uncertain/WaitingConfirmation/Executing stay nonterminal.
- Same session/key/body on ambiguous POST retry; no capability fields.
- Terminal snapshot hydrates canonical response via GET; unknown block/private fields never enter assistant text.
- Proxy preserves owner auth and incrementally forwards streams; cross-origin writes/internal routes blocked.
- Chromium: desktop1440×960 and mobile390×844 welcome/menu/composer fit; screenshots reviewed.
- Sanitized Markdown, escaped source/progress labels, public evidence separate from assistant answer.
- Authenticated artifact download succeeds against fixture; exported bytes retained as fixture evidence.
- Reload completed and active runs, reconnect after disconnect, lost receipt retry after reload without duplicate logical submission.
- WaitingConfirmation remains active; only canonical action allowlist renders; fixture reject only after explicit dialog confirmation.
- Cancel uses actual public cancellation path on fixture; reloading does not resubmit prompt.
- Backend selection separates histories and uses the same API flow.
- Bearer only in memory/header; plaintext token absent from localStorage. Changing owner separates history, restoring owner reloads its history.

## Limits

All chat/workflow/download checks use an isolated API fixture on random local ports. **No live agent/LLM request, approval, TRY, CREATE, APPLY or DEPLOY was sent by this UI task.** Source agreement covers both backend variants but is not a live integration certificate.

Live knowledge/reporting/proposal quality, production authentication/CORS, cross-owner server isolation, stale revision/approval/replay/uncertain mutation recovery and production deployment remain unverified here. These existing agent quality gates are unchanged. BAR charts use public values; other chart kinds are presented as data tables. Cookie history is tab-only because owner identity is not available to the client.

Browser test intentionally injects connection errors and an ambiguous POST; corresponding network console errors are expected. Application page errors: zero. Initial static-path/browser-fetch bugs found by tests were corrected before the final passing run; mobile test waits for the CSS transition and clicks the exposed overlay area.

## Evidence and rerun

- `test-results/browser-results.json`: 12 successful browser assertions, 0 page errors, real agent NOT_RUN. Generated evidence stays local and is excluded from Git; rerun the browser script to generate it on another machine.
- `test-results/desktop.png`, `mobile.png`, `chat.png`: reviewed UI screenshots with fixture data.
- `test-results/inventory.csv`: downloaded fixture bytes.
- `test/core.test.js`, `server.test.js`, `browser-smoke.mjs`: reproducible contract and browser checks.

Run from the repository root (Node22+ and Playwright installed, or an existing Playwright module path):

```bash
node --test test/*.test.js
PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node test/browser-smoke.mjs
```

Chromium installed in the standard `~/.cache/ms-playwright` cache. Runtime dependencies are for verification only; running the UI requires only Node22+.

## Streaming and Events update

12 October 2026: 12 Node checks and 12 Chromium browser checks PASS. Added event journal/projection bounds and explicit terminal snapshot GET tests. Browser checks prove text replace and append are visible before terminal, events remain after completion/reload, and reading a fresh snapshot adds a new connection sequence without prompt POST. Event details and scroll position survive incoming rendering.

Live read-only verification on the user existing run `ba2cd425-f74b-4796-85af-a1d8d4d07ea1`: Events panel received one v2 terminal `snapshot` from backend, status Completed, text737characters; preserved across reload. `test-results/live-events.png` captures the actual UI. No new prompt or configuration action was sent. Live incremental token delivery was not tested; public text withholding by backend remains valid.
