# moda — the authoring workflow (offline copy)

The deterministic loop (unmetered; `usage.metered_credits: 0` on every response):

1. `moda doctor --json` — step 0: connectivity, auth, version range.
2. `moda canvas create --name "…" [--brand bk_…] [--category …]`
3. `moda canvas markup CVS --file - < page.xml` — author content (see `moda docs markup`).
4. `moda canvas read CVS` — DSL snapshot + revision token + short ids.
5. `moda canvas screenshot CVS -o preview.png` — inspect with your host's image viewing.
6. `moda canvas edit CVS --file fix.js` — corrective edits (see `moda docs edit`).
7. `moda canvas lint CVS` — once when done; fix errors; re-lint at most once.
8. `moda export CVS --format pdf|pptx|png|jpeg -o out.…` — real text layers in PDF, native
   editable shapes in PPTX.
9. `moda canvas share CVS` — the live collaborative URL.

Exit-code contract: exit 0 = the operation COMMITTED (including committed-but-imperfect,
which sets `requires_repair: true` — author a follow-up fix, never re-run). Nonzero =
did not commit: 2 invalid input, 3 auth/scope, 4 not found, 5 conflict (busy canvas /
stale revision — re-read then re-apply), 6 payment/quota/rate, 7 server/transport (safe to
re-run: mutations carry idempotency keys).

Concurrency: any collaborator (browser tab, Omni, another CLI) may write between your calls.
The revision token is the fence — writes pinned to a stale revision fail loudly before any
mutation. Busy canvases are retried automatically (5s/15s/30s), then exit 5.

Resources:

- Brand: `moda brand show bk_… --json` → author markup with its colors/fonts/logo refs.
- Files: `moda file upload photo.png` → use the returned ref in `image(REF)` fills.
- Metered lanes (always labeled, never hidden): `moda task start --prompt "…"` (Omni
  escalation) and `moda media generate-image --prompt "…" --model …`. Both report a cost
  class before and an exact receipt after (`usage.metered_credits`).
