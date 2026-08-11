# `moda export` — deliverable files

```
moda export CANVAS_REF --format pdf|pptx|png|jpeg [-o PATH] [--page N]
            [--pixel-ratio 1..4] [--flatten] [--no-wait]
```

- **The hero claim, stated verbatim:** PDF exports carry real text layers, embedded fonts, and working hyperlinks; PPTX exports are native editable shapes and text — not screenshots pasted into a deck. `--flatten` degrades PDF to raster; use it only when the user asks.
- Export is deterministic-lane: **zero metered credits on every plan** (`usage.metered_credits: 0` on the response). Export rate is plan-quota enforced server-side; a throttle surfaces as a typed error with a retry hint.
- The CLI polls transparently when the render exceeds the sync window — you just get the file. `--no-wait` prints the export task id and exits 0; check later with the same verb or hand the id to the user.
- Downloads land at `-o` (default `<canvas-name>.<ext>` in the configured output dir). Print the final path in your reply.
- `--page N` exports a single 1-indexed page (there is no range selection); omit it for all pages. A multi-page png/jpeg export arrives as one `.zip` of per-page files.
- **`--format gif|mp4|webp` is rejected with a typed error** — animation export has no server lane; the Moda app is the path. Say so plainly instead of retrying.

Typical closes:

```
moda export CANVAS_REF --format pptx -o deck.pptx      # after a deck build
moda export CANVAS_REF --format pdf -o one-pager.pdf   # after a document build
```

Pair the file with the canvas link (`moda canvas share CANVAS_REF` prints a share URL; `editor_url` rides every mutation result) — the deliverable is both: the artifact file and the live, editable canvas.
