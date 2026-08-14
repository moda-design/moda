# `canvas_edit` — the sandboxed JS batch editor

`canvas_edit` runs synchronous JavaScript against the live canvas to **mutate** existing nodes, pages, variables, and animations. Use it for bulk styling, duplication, reordering, grouping, page creation, variable updates, and text/image swaps.

**It cannot delete.** The sandbox `remove()` is a throwing stub → the call fails typed with nothing applied. Deletion is only through `canvas_delete(ids=[…])`.

```
canvas_edit(canvas_ref, code, page=PAGE_ID, expected_revision=…)
```

- All operations go in ONE code payload; there is no second call.
- Need pixels right after the commit? Call `canvas_screenshot` on the result's `changed_page_ids`.
- `page` scopes only the read-only `nodes` snapshot to one page. It is NOT a destination.
- **Ids:** reference nodes/pages by the **short ids** from your latest `canvas_read` (e.g. `update('n7', …)`). The server resolves short refs to real ids for you. Real canvas ids you already hold also work (identity pass-through).
- Writes pin `expected_revision` (from your last `canvas_read`). A write against a stale revision fails typed `stale_revision` and commits nothing — re-read, then re-apply.

## Sandbox API surface

**Read-only snapshots** (frozen, captured BEFORE queued mutations replay — so a returned script value reflects pre-replay state): `nodes`, `pages` (incl. `page.background`), `variables`, `animations`, `comments`.

**Functions:**

- `create(type, props)` → temp id. Node types: `rectangle, ellipse, container, richtext, line, star, polygon, path, group, table, image`; plus `'page'`, `'variable'`, `'animation'`, `'comment'`. Aliases: `rect/box/square/shape`→rectangle, `text/label`→richtext, `circle/oval`→ellipse, `arrow`→line, `triangle/hex/hexagon/pentagon/octagon`→polygon. (`create('image', …)` is sugar for a pattern-filled shape.)
- `update(id, changes)` — nodes, pages, variables, animations, comment threads. Richtext: `{text}` plain, `{markdown}` or `{text, format:'markdown'}`, `{html}`/`{htmlContent}` for inline styling. Image replacement: `{src, fit?:'cover'|'contain'|'match', crop?}` (crop = keyword, `{x,y}` focus 0..1, `{x,y,w,h}` bbox, or `'50% 25%'`; `objectPosition` alias). Backdrop: `{backdrop:'blur'|'glass'|'pixelate'|'dither'|'none', backdropPreset?:'subtle'|'strong'}`. Comments: `update('c1', {reply:'…', resolved:true})`. Tables: structural patches are reconciled — see **Tables** below.
- `duplicate(ids[, options])` — nodes and/or pages → temp ids; cross-page via `{destinationPageId}`. Unknown option keys are invalid.
- `reorder(id, position[, targetId])` — position: `'front'|'forward'|'backward'|'back'|'before'|'after'|number`.
- `group(ids[, options])`, `ungroup(id)`, `movePages(ids, {index?, afterPageId?})`.
- `details(id)` — full node detail (needed for effect arrays the lightweight `nodes` snapshots omit).
- `print(...args)` / `log(...)` / `inspect(label, value)` — output comes back in the JSON result.
- `Math` — a frozen facade (the raw global is withheld).
- `remove()` — **BLOCKED**: throws, nothing applies. Use `canvas_delete(ids=[…])`.

## Video clips — the fill owns playback, the bar owns placement

A clip reaches a canvas only through `<video src="file_…"/>` markup (references/markup.md): `create('rectangle', {fillVideoSrc})` strips the video props with a `create_video_fill_ignored` warning, because placement has to run the server-side ref resolver.

- **Writable on a placed clip** via `update(id, …)`: `fillVideoTrimStartMs`, `fillVideoTrimEndMs`, `fillVideoMuted`, `fillVideoVolume` (0–1), `fillVideoPlaybackRate` (0.1–4), `fillVideoLoop`. Trim off the readable `fillVideoDurationMs` — "the middle 3 s of this 8 s clip" is one call.
- `null` clears a numeric field back to its default: `update(id, {fillVideoTrimEndMs: null})` restores the clip's full length.
- Bad values are ERRORS naming the field and its range, never clamped or dropped — a window outside `[0, fillVideoDurationMs]`, an inverted window (`trimEnd <= trimStart`), an out-of-range volume or rate, or any of these on a node with no video fill. Only the bounds a patch actually writes are range-checked, so a clip left with an out-of-range trim can still be muted or re-rated.
- `fillVideoSrc`, `fillVideoAssetId`, `fillVideoPosterSrc`, `fillVideoNaturalDimensions`, `fillVideoDurationMs` and `fillVideoHasAudio` are NOT writable — the first four belong to the ref resolver (swapping a source is placement: place a new `<video>`), the last two are facts read off the file.
- **`t.video(node, {startMs, endMs})`** (`timeline.video`, inside `motion.page(…)` on an animation canvas) places that clip's bar. The bar is the clip's LIFETIME on the page — outside it the node is HIDDEN, not frozen on a poster — and N bars at different `startMs` IS a cut. `endMs` defaults to the trimmed clip's length clamped to the page. One bar per node: calling it again REPLACES that node's bar (also how you retime one). Its only options are `startMs` (alias `at`), `endMs`, `description`; `offsetMs`, `rate` and `loop` are hard errors redirecting to `fillVideoTrimStartMs`, `fillVideoPlaybackRate` and `fillVideoLoop`. Set the fill FIRST — the bar re-derives from it on every call. Drop one with `t.clearTrack(id)`.

## Tables — `create('table', props)` / `update(id, changes)`

Table structure is the one *shaped* (non-scalar) patch, so a reconciler runs on every table update: it pads a jagged `cells` array, mints missing cell ids, refits `rows`/`columns` to the grid, rewrites `width`/`height` to the axis sums, and remaps header metadata. It repairs and **warns** rather than rejecting — read the warnings.

- **`cells`** — 2D row-major array, always written WHOLE: a short/partial array is not a merge, its dimensions BECOME the grid and `rows`/`columns` are grown/trimmed to match. Cell shape: `{ id?, textContent, textPadding?, textHorizontalAlign?, textVerticalAlign?, textResizeMode?: 'no-resize' }` — `textContent` is richtext-style HTML (`<p style="font-size: 20px; font-family: Inter; color: #000000">…</p>`); a missing/duplicate `id` is minted, and omitted cell props get the editor defaults back.
- **`rows` / `columns`** — `[{ size: number, fill?: color }]`; a bare `[number]` array is accepted; `size` clamps to ≥5. `fill` is a ROW background (ignored on columns) and beats `headerBackgroundColor` + the zebra cycle. Count = array length, so adding/removing rows or columns means resizing `cells` (or the axis array).
- **`rowStrokeConfig` / `columnStrokeConfig`** — `'all'|'outside'|'inside'|'after-first'|'none'`; anything else is dropped with a warning.
- **`backgroundColors`** — `string[]` zebra cycle by row index. **`headerBackgroundColor`** — one color, ROW 0 only.
- Generic fields also apply: `x`,`y`,`width`,`height`,`opacity`,`hidden`,`locked`,`metadata`,`stroke`,`strokeWidth`,`cornerRadius`. An explicit `width`/`height` stays authoritative — axis sizes rescale into it, exactly like a drag-resize. `cornerRadius` rounds the 4 corner cells; `opacity` multiplies into cells + gridlines.
- Markup attr names work here too and normalize: `headerBackground`, `headerColor`, `headerFontWeight`, `rowHeight`, `cellPadding`, `rowLines`/`columnLines`, `fill` (→ `backgroundColors`), plus `fontSize`/`fontFamily`/`color`/`fontWeight`/`fontStyle`/`letterSpacing`/`lineHeight` — those text styles rewrite EVERY cell's HTML (header cells keep their own header overrides).
- Header text styling is keyed by `metadata.tableHeaderCells` — the CELL IDS of the header cells. Cell ids are stable across row/column inserts and deletes, so the designation follows the cells.
- `create('table', props)`: `rows`/`columns` also accept a plain COUNT (`create('table', {rows:3, columns:4})` → a 3×4 grid of 150×50 cells); every other prop lands through the same reconciled update path.

## Operation limits

Over-limit calls are ignored with a structured warning, not a hard error — watch `operation_counts.skipped`.

| Limit | Value |
|---|---|
| create() calls | 500 |
| duplicate() calls | 200 |
| update() calls | 10,000 |
| reorder() calls | 500 |
| group() / ungroup() calls | 100 / 100 |
| movePages() calls | 100 |
| details() calls | 200 |
| print entries | 32 |
| `nodes` snapshot cap | 10,000 |

## Sandbox constraints

- **Code cap: 16,384 chars.** Execution budget: **100 ms, synchronous.** Runaway loops trip an "execution timeout" (a loop guard covers every loop form). Heavy O(n²) work over thousands of snapshots is the classic trip — **batch across multiple `canvas_edit` calls.**
- **Must be synchronous.** These get a clear pre-run error: `eval`, `new Function`, `import`, `require`, `fetch(`, `await`, `async`, `window`, `document`, `globalThis`, `process`, `console` (use `print`/`inspect`).
- The sandbox is a speedbump, not a hard security boundary — don't rely on it to contain untrusted code.

## Result shape (what to read)

Key fields in the result of a committed edit:

- `operation_counts { queued, applied, skipped }` — **`skipped > 0` = ops silently dropped** (unresolved ids or hit limits). Read the skipped bucket first.
- `created_ids`, `updated_ids`, `removed_ids` — the mutation's own id arrays.
- `warnings` — structured, per-op. **Any entry with `severity: "error"` requires remediation even on a success.**
- `requires_repair`, `no_op_reason` (`lexically_mutates_zero_applied` | `all_queued_ops_skipped` | `partial_no_op`) — the edit committed but did nothing useful; repair before building more.
- `revision` — the post-commit revision token (pin it as `expected_revision` on your next write).
- `lint { errors, warnings }` — summary counts only; full findings via `canvas_read(lint=true)`.
- Any `print`/`inspect` output rides in the result.

## Failure semantics — NOTHING applied

When the call fails typed (`invalid_edit_program`), no ops are applied — edit failures are atomic:

- **Parse failure** — fix the *syntax*; do NOT strip APIs you think are blocked.
- **Blocked pattern** — a sandbox speedbump was tripped (or you called `remove()`). Remove the forbidden pattern.
- **Runtime throw** in code with mutation call sites: queued ops are NOT applied. Diagnostics carry `{line, column, code_excerpt}` plus any prints before the throw. (A read-only probe that throws recovers as a warning instead.)
- **No nodes found** — empty scope, no mutations; the error details list valid page ids.
- **Invalid page** — the `page` you scoped to is not in the live document (deleted mid-session, or your view is stale). Nothing was edited. Do NOT recreate the lost work: `canvas_read` for current page ids and retry against a page that exists.

**On any typed error: STOP, read it and its hint, fix the code, then retry — retrying is safe because a failed script made no changes.** Do not blindly re-send.

## Appendix — page resize recipe

There is no dedicated page-resize verb; compose it from edit primitives: group the page's top-level nodes (skip this when a single node or group already holds everything), set the page's new width/height with `update(pageId, …)`, then scale that group — or that sole root — to fit the new size. Grouping first keeps the layout intact while the page changes under it. Resizing to the same aspect ratio is a single uniform scale. To a different aspect ratio, still scale uniformly and balance the leftover space as margins — don't stretch content non-uniformly; reflow the layout with `canvas_apply_markup` in replace mode only when the user wants the design recomposed for the new shape.
