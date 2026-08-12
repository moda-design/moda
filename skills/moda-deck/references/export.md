# `moda export` — deliverable files

```
moda export CANVAS_REF --format pdf|pptx|png|jpeg [-o PATH] [--page N]
            [--pixel-ratio 1..4] [--flatten] [--no-wait]
```

- **Export is ASK-FIRST.** The live link (share/editor URL) is the handoff,
  always — run this verb only when the user named a file or format ("a PDF
  one-pager", "PPTX", "send me a file" — their format words win, and
  platform-implied files like the LinkedIn-carousel PDF count) or accepted
  the single brief offer at handoff. Never auto-export as ceremony. Share
  the link BEFORE any export — the link never depends on the export
  succeeding.
- **Shader fills and animations freeze in static exports** (png/jpeg/pdf/
  pptx) — they render live in-app. When such a canvas gets a file request
  or offer, say so: "this design has animated elements — a static file
  freezes them; the live link shows the motion." A motion-preserving
  gif/mp4 lane exists only where a newer server+CLI pair has it (check
  `moda export --help`); on this build the typed refusal is the honest
  answer — deliver static + the live link.
- **The hero claim, stated verbatim:** PDF exports carry real text layers and embedded fonts — but hyperlinks are flattened to plain text in PDF output (never promise clickable links); PPTX exports are native editable shapes and text — not screenshots pasted into a deck. `--flatten` degrades PDF to raster; use it only when the user asks.
- Export is deterministic-lane: **zero metered credits on every plan** (`usage.metered_credits: 0` on the response). Export rate is plan-quota enforced server-side; a throttle surfaces as a typed error with a retry hint.
- The CLI polls transparently when the render exceeds the sync window — you just get the file. `--no-wait` prints the export task id and exits 0; check later with the same verb or hand the id to the user.
- Never poll with sleeps longer than 60 seconds; prefer the CLI's own waiting (the default sync wait, or `--no-wait` + re-check with the same verb). If export fails with the same typed code twice, deliver the share link + screenshots and note the export failure honestly.
- Downloads land at `-o` (default `<canvas>.<ext>` in the configured output dir; with `--page N` the default is `<canvas>.pN.<ext>`, so per-page loops never clobber). Print the final path in your reply.
- **Multi-page png/jpeg arrives as ONE zip of per-page images** — the response's `delivered_format` says `zip` and the CLI names the file `.zip`. That zip is the deliverable for image carousels; don't rename it to `.png`.
- `--page N` exports a single 1-indexed page (there is no range selection); omit it for all pages. A multi-page png/jpeg export arrives as one `.zip` of per-page files.
- **`--format gif|mp4|webp` is rejected with a typed error** — animation export has no server lane; the Moda app is the path. Say so plainly instead of retrying.

Typical closes:

```
moda export CANVAS_REF --format pptx -o deck.pptx      # after a deck build
moda export CANVAS_REF --format pdf -o one-pager.pdf   # after a document build
```

Pair the file with the canvas link (`moda canvas share CANVAS_REF` prints a share URL; `editor_url` rides every mutation result) — the deliverable is both: the artifact file and the live, editable canvas.
