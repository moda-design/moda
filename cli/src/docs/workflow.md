# moda — the authoring workflow (offline copy)

The deterministic loop (unmetered; `usage.metered_credits: 0` on every response):

1. `moda doctor --json` — step 0: connectivity, auth, version range.
2. `moda canvas create --name "…" [--size WxH] [--category …]` (brand application is
   client-side: `moda brand show` the kit and author with its tokens).
3. `moda canvas markup CVS --page p_… --file - < page.xml` — author content (see `moda docs markup`).
4. `moda canvas read CVS` — DSL snapshot + revision token + short ids.
5. `moda canvas screenshot CVS -o preview.png` — inspect with your host's image viewing.
6. `moda canvas edit CVS --file fix.js` — corrective edits (see `moda docs edit`).
7. `moda canvas lint CVS` — once when done; fix errors; re-lint at most once.
8. `moda export CVS --format pdf|pptx|png|jpeg -o out.…` — real text layers in PDF, native
   editable shapes in PPTX.
9. `moda canvas share CVS` — the live collaborative URL.

Screenshot sugar: the content mutation verbs (`moda canvas markup` / `moda canvas edit`)
accept `--screenshot PATH`. After the commit, the CLI immediately runs the standalone capture
for the touched page(s) — the `--page` target when given, else the default capture — and
writes the file(s) exactly like `moda canvas screenshot -o PATH`
(single page = file, several = directory; auto-batching included). One command instead of two
when a screenshot is your next step anyway. Under `--json` the capture rides the mutation
document as `screenshot: {ok, pages[], truncated?, capture_calls?}`. A capture failure never
changes the mutation's exit code (the mutation committed): it surfaces on stderr and as
`screenshot.ok: false` — re-run `moda canvas screenshot` to retry the capture alone.

Reasoning effort: deterministic design authoring does not need maximum reasoning effort. If
your harness exposes an effort/thinking control, moderate settings are usually sufficient for
markup authoring and make the loop noticeably faster; screenshots remain the quality arbiter —
judge results with your eyes on the rendered pixels, not with longer deliberation.

Exit-code contract: exit 0 = the operation COMMITTED (including committed-but-imperfect,
which sets `requires_repair: true` — author a follow-up fix, never re-run). Nonzero =
did not commit: 2 invalid input, 3 auth/scope, 4 not found, 5 conflict (busy canvas /
stale revision — re-read then re-apply), 6 payment/quota/rate, 7 server/transport (safe to
re-run: mutations carry idempotency keys).

Concurrency: any collaborator (browser tab, Omni, another CLI) may write between your calls.
The revision token is the fence — writes pinned to a stale revision fail loudly before any
mutation. Pinnable tokens come only from reads (`moda canvas read` / `moda canvas lint`); the
`revision` on a mutation response is advisory — never pin it. Busy canvases are retried
automatically (5s/15s/30s), then exit 5.

Resources:

- Brand: `moda brand show bk_… --json` → author markup with its colors/fonts/logo refs.
- Files: `moda file upload photo.png` → use the returned `file_…` ref in `image(REF)` fills
  and media inputs; `moda file search QUERY` finds existing team assets.
- Metered lanes (always labeled, never hidden): `moda task start --prompt "…"` (Omni
  escalation) and `moda media generate-image --prompt "…" --model …`. Both are labeled
  `usage.class: "metered"`; exact credits are enriched asynchronously on your account usage.

## The --json envelope (versioned machine surface)

`--json` emits exactly one compact JSON document on stdout (`--pretty` to
pretty-print). These fields are a stability contract; server payload fields
ride alongside them additively:

- `ok` — whether the invocation succeeded. On failure the document is
  `{ok: false, error: {type, code, message, hint?, doc_url?, request_id?,
  retryable?, retry_after_s?, details?}, meta}` and the exit code is nonzero
  (`moda last-error` re-prints the last failure's envelope).
- `operation` — the CLI verb lane (e.g. "canvas.edit", "site.publish").
- `meta.request_id` (server correlation) and `meta.duration_ms` (latency).
  CLI/API versions are not repeated per-response — `moda version` owns them.
- Metered lanes add `metered: true` + the `usage` receipt; keyed replays add
  `replayed: true`.
- Canvas mutations add `revision`, `warnings`, `operation_counts`, and
  `requires_repair`; `--screenshot` adds `screenshot: {ok, pages[]}`.
- List/search lanes add `returned` (count of items in this response).
- `notes[]` carries format advisories (e.g. PDF hyperlink flattening).
- `moda describe --json` is the machine-readable verb schema (positionals,
  flags with type/required/default, and the semantic markers `mutating`,
  `destructive`, `metered`, `read_lane`); `moda describe <verb> --json`
  returns one verb in full. Part of this versioned surface.
- Marker legend: the markers cover state change (`mutating`), credit spend
  (`metered`), and irreversibility (`destructive`) only. `site publish`
  additionally makes content publicly reachable — there is no separate
  public-exposure marker (revisit if a second such verb appears).
- Big-result routing: `--output FILE` on `canvas read`, `task list`, and
  `web read` writes the full payload to the file and shrinks the stdout
  envelope to summary fields + `output`/`bytes` + a bounded `preview`.
- Export adds `requested_format` + `delivered_format` — what the file
  actually is (multi-page raster exports deliver `zip`).
