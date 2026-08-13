# `export` — deliverable files

```
export(canvas_ref, format='pdf'|'pptx'|'png'|'jpeg'|'mp4'|'gif',   # mp4/gif REQUIRE page
       page=N, pixel_ratio=1..4, flatten=…)
```

- **Export is ASK-FIRST.** The live link (share/editor URL) is the handoff,
  always — run it only when the user named a file or format ("a PDF
  one-pager", "PPTX", "send me a file" — their format words win, and
  platform-implied files like the LinkedIn-carousel PDF count) or accepted
  the single brief offer at handoff. Never auto-export as ceremony. Share
  the link BEFORE any export — the link never depends on the export
  succeeding.
- **Shader fills and animations freeze in static exports** (png/jpeg/pdf/
  pptx) — they render live in-app. The motion-preserving exports are
  `format='mp4'` and `format='gif'` (one page's animation per file; a page
  with NO animation rejects typed `no_animation` — that is the honest
  answer, deliver a still + the live link). When an animated canvas gets a
  static-file request, offer the motion file too.
- **The hero claim, stated verbatim:** PDF exports carry real text layers and embedded fonts — but hyperlinks are flattened to plain text in PDF output (never promise clickable links); PPTX exports are native editable shapes and text — not screenshots pasted into a deck. **PDF exports need `flatten=false`** — the server default (`flatten=true`) rasterizes the PDF; pass `flatten=false` on every PDF export unless the user explicitly wants a flat raster file.
- **Read the `warnings[]` on a completed export.** Quality caveats about a file that still succeeded — `pptx_shape_rasterized` (some images baked into the slide rather than editable shapes), `pptx_content_dropped` (elements missing from the deck entirely), `pdf_links_flattened` (hyperlinks not clickable). Relay the caveat honestly when you hand over the file. A warning is never a reason to re-run the export — an identical re-run degrades identically — and never a reason to withhold the file; treat an unrecognized code as informational and pass its message along.
- Export is deterministic-lane: **zero metered credits on every plan** (`usage.metered_credits: 0` on the response). Export rate is plan-quota enforced server-side; a throttle surfaces as a typed error with a retry hint.
- A render that outlasts the wait budget returns a job handle — poll `task_status` (its `retry_after_seconds` says when); re-calling `export` reuses the same job, it never renders twice.
- Never poll with sleeps longer than 60 seconds; follow `task_status`'s `retry_after_seconds`. If export fails with the same typed code twice, deliver the share link + screenshots and note the export failure honestly.
- The result carries a short-lived download link — hand it to the user in your reply promptly (it expires).
- **Multi-page png/jpeg arrives as ONE zip of per-page images** — the response's `delivered_format` says `zip`. That zip is the deliverable for image carousels; don't call it a png.
- `page=N` exports a single 1-indexed page (there is no range selection); omit it for all pages. A multi-page png/jpeg export arrives as one `.zip` of per-page files.
- **`format='webp'` is rejected with a typed error** — it has no server lane. Say so plainly instead of retrying; the supported stills are pdf, pptx, png, jpeg.

Typical closes:

```
export(canvas_ref, format='pptx')   # after a deck build
export(canvas_ref, format='pdf')    # after a document build
```

Pair the file with the canvas link (`canvas_share` mints a share URL; `editor_url` rides every mutation result) — the deliverable is both: the artifact file and the live, editable canvas.
