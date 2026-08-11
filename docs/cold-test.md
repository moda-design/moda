# Cold-test protocol — the acceptance run IS the test

The skills in this repo are accepted only by cold-session runs. No unit test
substitutes for a fresh agent, a fresh machine, and a scripted request with
zero coaching.

## Environment (cold means cold)

A machine, container, or user account with:

- no `moda` on PATH, no `~/.config/moda/`, no keychain entry;
- no Moda skills installed, no shell history mentioning moda;
- the harness (Claude Code; separately Codex) authenticated to its own model
  provider only.

A Moda test account on the dogfood team exists (canvas-tools enablement on,
credits available) but is not logged in anywhere. Pre-merge local-stack
variant: identical, pointed at the worktree server via the CLI's API-base
override.

## Script (per run, per harness)

1. Operator pastes the install line(s) from INSTALL.md section 1, runs them,
   starts a **new session**.
2. Operator pastes ONE acceptance request verbatim. The three scripted
   requests (each run picks one; all three must pass before ship):
   - **Deck**: "Make a 10-slide investor-update deck from this repo's README
     and docs/, on our brand, and give me the PPTX and a link I can share."
     (doctor → auth → brand → create → add-pages → markup ×N → lint →
     screenshot → export pptx → share)
   - **One-pager + media**: "Turn NOTES.md into a designed one-page PDF;
     generate a fitting hero image for the top." (upload/refs → markup →
     metered generate-image with model param + cost class surfaced + receipt
     → export pdf)
   - **Edit round-trip**: paste a canvas URL from a previous run — "The third
     slide is cluttered and off-brand; fix it, keep the numbers exactly."
     (read → routing → edit/markup → data preservation → lint → screenshot →
     URL)
3. When the agent stops per Step 0 (CLI missing / not authenticated), the
   operator runs exactly the pinned command the agent relayed, replies
   "done", nothing more.

## "No coaching", operationally

The operator MAY:

- paste the scripted request;
- run relayed pinned commands and say "done";
- answer product/content preference questions as an end user ("blue is
  fine", "5 slides is enough").

The operator may NEVER:

- name a CLI verb, flag, file, reference doc, skill, or Moda concept the
  agent hasn't surfaced;
- correct or diagnose a failed call;
- suggest verifying, linting, screenshotting, retrying, or re-reading;
- supply an id or URL format hint.

**Any violation voids the run** — fix the skill text in this repo (shared/
first, then fanout), reinstall, and restart cold.

## Evidence per run

- Full harness transcript (session log / JSONL).
- `moda doctor --json` output.
- The CLI invocation log: every argv + exit code + `requires_repair` from
  `--json` stdout.
- Final canvas URL + `moda canvas screenshot` PNGs.
- Export artifact + checksum.
- Credit-ledger delta and per-call receipts for every metered verb — they
  must equal the receipts the agent surfaced.
- A scoring sheet mapping the run's verbs onto the omni-parity
  DETERMINISTIC + METERED rows exercised (studio:
  docs/roadmap/moda-for-agents/omni-parity.md).

## Pass bar

- Artifact accepted by the operator-as-user.
- Zero coaching violations.
- Every nonzero exit followed by the typed hint's recovery — no blind
  retries, no duplicated committed work.
- Lint errors fixed before the final reply.
- Metered cost class surfaced *before* each metered call.

**Ship gate: 2 consecutive clean runs per request per harness** (Claude Code
and Codex), and cumulative coverage of all DETERMINISTIC + METERED parity
rows reachable by the five skills.
