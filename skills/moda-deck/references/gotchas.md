# Gotchas & known divergences

## Headless execution — what degrades or refuses

Canvas verbs execute on Moda's tool host, not a full browser tab. Most things behave exactly like the editor; a few paths degrade or return a typed refusal. (Treat a typed refusal you get back as authoritative over this doc.)

1. **`<latex>` on a host without the render seam** → a typed per-element refusal. It degrades **only that element/update**, not the whole call — the rest of your markup still lands.
2. **Canvas-space region captures on FLOATING (freeform) layouts** are unsupported. Page-anchored captures (default layouts) work fine, so `moda canvas screenshot` of a normal page is unaffected.
3. **Selection is not a document operation.** Nothing in this surface selects nodes for the user; the change itself is what collaborators see.

Other minor divergences worth knowing: shrink-fit font sizes can land within a ±6% band; non-catalog fonts are heuristically measured; lint contrast sampling degrades over image fills; screenshot bytes differ slightly from the browser.

## Curated risk list

- **The 100 ms synchronous budget is tight.** Heavy O(n²) loops over thousands of `nodes` snapshots trip an "execution timeout" and nothing applies. Batch across multiple `moda canvas edit` calls.
- **Two different size caps — don't conflate them.** `moda canvas edit` code caps at **16,384 chars**. The markup `<generate>` block caps at **4,096 chars / 2,000 elements per block** (5,000 global). They are unrelated.
- **An exit-0 mutation can still be a no-op or need repair.** `warnings` entries with `severity: "error"`, plus `requires_repair` / `no_op_reason`, mean remediation is required even though the command exited 0. And `operation_counts.skipped > 0` means SOME ops were silently dropped (unresolved ids or hit limits) — check the skipped bucket.
- **Any nonzero exit means NOTHING committed.** Fix the cause per the typed error's hint and retry; retrying is safe because a failed call made no changes (and mutations carry idempotency keys, so even a retried timeout cannot double-apply).
- **Deletion is intentionally absent from edit code.** `remove()` throws. `moda canvas delete-items` is the only deletion path.
- **Animation authoring is not part of this surface today.** For motion work, escalate to `moda task start` (metered) or hand the user the canvas link — the Moda app owns the animation timeline.
- **`failedAssets` in a screenshot are transient renderer load failures — never regenerate or delete an image because of them** (a real regression class).
- **Two coordinate frames.** Node `x`/`y` are parent-relative; markup coords are page-relative (or canvas-absolute only with `--page canvas` on a Design canvas). Mixing frames misplaces nodes inside groups.
- **Recreate fidelity.** Markup shorthand is lossy for explicit gradient geometry and shadow opacity. If the state shows radial/conic centers/radii/rotations or a shadow opacity, preserve them via `moda canvas edit` raw gradient/shadow object fields rather than flattening to centered gradients or opaque shadows. Likewise carry forward any shadow, inner-shadow, gradient stroke, stroke-align, blend-mode, clip-mask, or blur fields a node had before you recreated it — dropping visible effects during a recreate is a regression.
- **No video inputs on canvases.** A canvas takes images and documents only — no video fill, no "video background". Video files exist on this surface only as inputs/outputs of the metered `moda media` video verbs, and the CLI export verb rejects gif/mp4 with a typed error (the Moda app is the path for animation export). Never tell the user to put a video on a canvas; offer a still frame as a background image instead.

## Top 8 mistakes — WRONG / CORRECT

**1. Deleting inside edit code**

```js
// WRONG — throws, nothing applies
remove('n7');
```

```
CORRECT — use the deletion verb:
moda canvas delete-items CANVAS_REF n7
```

**2. Reusing stale short ids after a structural change**

```
WRONG — created three nodes with moda canvas markup, then immediately
ran moda canvas edit referencing "n9" guessed from before the change.
CORRECT — moda canvas read again to pick up the new short ids (and the
new revision), THEN edit.
```

**3. Faking bullets / splitting paragraphs**

```xml
<!-- WRONG — dots + separate text nodes, misaligned and unstyled -->
<row><ellipse r="4"/><text>First point</text></row>
<text>Line one</text><text>Line two</text>
```

```xml
<!-- CORRECT — one markdown text node -->
<text format="markdown">
- First point
- Second point
</text>
```

**4. `fill` sizing on a root container**

```xml
<!-- WRONG — "uses fill but has no parent container" error -->
<content><column width="fill">…</column></content>
```

```xml
<!-- CORRECT — hug or explicit dimensions at the root -->
<content><column width="hug">…</column></content>
```

**5. Trusting exit 0 without reading the report**

```
WRONG — command exits 0, you move on.
CORRECT — inspect warnings (severity "error"), requires_repair,
no_op_reason, and operation_counts.skipped; remediate before continuing.
```

**6. Reacting to `failedAssets` by regenerating the image**

```
WRONG — screenshot JSON shows failedAssets:[{nodeId:'n4'}] → delete + re-create the image.
CORRECT — leave the image alone; re-run moda canvas screenshot shortly.
```

**7. One oversized, async, brute-force edit**

```js
// WRONG — >16k chars, O(n²), and async — trips timeout / speedbump, nothing applies
for (const a of nodes) for (const b of nodes) { await something(); update(a.id, …); }
```

```
CORRECT — synchronous, single-pass, and split across several moda canvas edit
calls, re-reading state between batches.
```

**8. `<line>` with no endpoints outside a flex container**

```xml
<!-- WRONG — skipped with line_missing_endpoints -->
<content><line stroke="#000"/></content>
```

```xml
<!-- CORRECT — give explicit endpoints (or put a bare <line/> INSIDE a row/column as a divider) -->
<content><line x1="0" y1="0" x2="400" y2="0" stroke="#000"/></content>
```
