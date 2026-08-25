# Finished-cut recipes — composed, branded motion

A raw generated clip is a commodity: every video tool makes one. The finished
CUT is not. What this surface composes that a bare model cannot — the brand's
own logo files, its real fonts and palette, crisp type over the footage, two
or three shots cut on a timeline, an mp4/gif export, and a live canvas link
that stays editable afterwards.

Load this file when the ask names a **deliverable** rather than a clip: "a
logo animation", "a teaser for this product", "an ad for Reels", "a 300×250
that animates". A
prompt-only clip stays in references/video.md workflow 2 — do not pad a
simple ask with a canvas.

references/video.md is the prerequisite (lanes, the model roster, the knob
rules, the draft ladder). Every recipe here RUNS that ladder rather than
one-shotting the hero model. Registry rates for the lanes below: Veo 3.1 Lite is
**$0.03/s silent at 720p** (its audio default bills $0.05/s, so pass
`--no-generate-audio` on every draft), Veo 3.1 Fast **$0.10/s**, Veo 3.1
**$0.20/s** (720p and 1080p share that rate; audio doubles it), Seedance 2.0
Fast **$0.2419/s at 720p** and area-metered, so 480p is materially cheaper on
it. `moda media models` is the authority when any of that has moved.

## The shape all three share

1. **Brand first.** Step 0 listed the kits; `moda brand show BRAND_REF --json`
   gives the logo `file_` refs, the palette, and the font families — and you
   LOOK at the logo variants before placing one (references/brand.md). Copy
   hex values from that read, never from memory.
2. **An animation canvas at the deliverable's exact size.** Motion applies
   only on `--category animation`; on any other canvas every `motion` call is
   dropped with `timeline_motion_non_animation`. Read the canvas once after
   creating it — the page short id (`p_a`) that every markup and motion call
   takes comes from that read, and so do the node ids the motion pass needs.
3. **Draft the footage fast, verify, fix, then take the hero render.**
4. **Place clips with `<video>` markup, then layer real type over them.**
   `<video>` is the only way a clip reaches a canvas (references/markup.md);
   the clip is a fill on a rectangle, so z-order and opacity come free.
5. **Layout pass, THEN motion pass.** Text presets and recipes refuse a node
   created in the same edit batch, so motion is always a later
   `moda canvas edit` call.
6. **Live link first, mp4/gif second.** A png/jpeg/pdf/pptx export preserves
   only the clip's poster frame, not its motion. If placement warned
   `video_poster_unavailable`, that clip exports blank (references/gotchas.md).

## Recipe 1 — Logo animation

"Animate our logo." The mark itself stays VECTOR — a video model cannot
redraw a wordmark and will not be asked to. Generation, when it appears at
all, makes the BACKDROP behind a real logo file.

**1a. Vector-only (the default).** Free, deterministic, exact, and gif-ready:

```
moda canvas create --name "Acme stinger" --size 1920x1080 --pages 1 --category animation
moda canvas read CANVAS_REF          # page short id (p_a) and, after markup, node ids
moda canvas markup CANVAS_REF --file - --page p_a <<'XML'
<content font-family="…the kit's title family…">
  <background fill="#0F172A"/>
  <image src="file_…" x="660" y="420" width="600" height="200" fit="contain"/>
  <text x="560" y="660" width="800" font-size="30" color="#94A3B8" text-align="center">Tagline in the kit's font</text>
</content>
XML
```

Then the motion pass, in a second call:

```
moda canvas edit CANVAS_REF --file - <<'JS'
motion.page('p_a', { durationMs: 3200 }, (t) => {
  t.recipe('n2', 'recipe-rise', { at: 200 });
  t.effect('n3', 'opacity-fade-in', { startMs: 900, durationMs: 600 });
  t.colorTween('page-background', 'fill', ['#0F172A', '#1E293B'], { startMs: 0, durationMs: 3200 });
});
JS
moda export CANVAS_REF --format gif --page 1 -o stinger.gif
```

A logo built from vetted vector shapes can also DRAW itself on with
`t.effect(node, 'draw-on', …)` — `trimPathStart`/`trimPathEnd` are animatable
paths, so a stroked mark writes on stroke by stroke.

**1b. Logo over generated motion (metered).** Same canvas; the backdrop is a
clip. Draft it on the fast lane first:

```
moda media generate-video --prompt "Abstract slow light sweep across a deep navy field, soft volumetric haze, no text, no logos, no people, seamless loop" \
  --model veo-3.1-lite --duration 4 --resolution 720p --no-generate-audio -o backdrop-draft.mp4
```

That draft is 4 s at 720p, silent. Verify it (read `applied` and
`adjustments`; view it if your harness has vision), fix the prompt if the
motion is wrong, and only then commit: the same prompt at 8 s and 1080p on
Veo 3.1 Lite, or on Veo 3.1 when the backdrop carries the piece and deserves
cinematic quality (silent — a stinger under someone else's soundtrack does
not need audio).

Place the keeper under the logo, muted, sized to the page:

```
moda canvas markup CANVAS_REF --file - --page p_a --mode replace <<'XML'
<content font-family="…the kit's title family…">
  <video src="file_…" x="0" y="0" width="1920" height="1080" fit="cover" muted="muted"/>
  <image src="file_…" x="660" y="420" width="600" height="200" fit="contain"/>
</content>
XML
```

Motion pass: `t.video('n1', { startMs: 0 })` places the backdrop's bar for
the whole page, and the logo's entrance rides on top exactly as in 1a. Export
gif for a signature or chat avatar, mp4 when it needs audio or length.

**Deliver:** the canvas link first, then the file, then one brief offer of
`moda media upscale-video` if the backdrop is the hero and 1080p is not
enough.

## Recipe 2 — Product teaser

Product stills → image-to-video beats → a cut on the timeline → brand type
over it → mp4. Three beats and 8–12 seconds is the shape; more beats rarely
makes a better teaser.

**1. Get the stills in.** `moda file upload shot-front.jpg` returns a durable
`file_` ref (a local path passed straight to a media flag uploads itself too,
but an explicit upload gives you the ref to reuse across beats).

**2. Draft every beat on the fast lane, in one pass.** One prompt per beat,
each naming the ONE motion it does — a push-in, an orbit, a rack focus:

```
moda media generate-video --prompt "Slow push-in on the product on a matte concrete surface, soft window light, shallow depth of field, no text" \
  --model veo-3.1-lite --image file_… --duration 4 --resolution 720p --no-generate-audio -o beat1-draft.mp4
```

Run all three drafts in the same pass (`--no-wait`, then collect): you see the
WHOLE cut before committing to any beat of it, which is the point. Reach for
`--model seedance-2.0-fast` instead when the beat needs Seedance's controls
in the draft (an `--end-image` morph, a non-16:9 ratio, `--reference` product
boards): it is 80% of Seedance 2.0's price at the same 4–15 s envelope, and
its price is metered on frame AREA, so `--resolution 480p` is the natural
draft size on it.

**3. Verify before the hero render.** Read `applied` and `adjustments` on
each result (duration and resolution snap silently), look at the clips if
your harness can, and fix the losing prompts. Re-running an unchanged command
resumes the same render instead of paying twice — a real retake needs a
changed knob (`--seed` where the model takes one, or a changed prompt).

**4. Take the hero renders** — only the beats that survived, at the length
and resolution the cut actually needs. Veo 3.1 Fast at `$0.10/s` is the
usual step up; Veo 3.1 at `$0.20/s` when the footage carries the whole ad.

**5. Compose the cut.** One animation canvas, all three clips placed, each
sized to the full frame and stacked — the timeline, not z-order, decides
what is on screen:

```
moda canvas create --name "Product teaser" --size 1920x1080 --pages 1 --category animation
moda canvas markup CANVAS_REF --file - --page p_a <<'XML'
<content font-family="…the kit's title family…">
  <video src="file_…" x="0" y="0" width="1920" height="1080" fit="cover" muted="muted"/>
  <video src="file_…" x="0" y="0" width="1920" height="1080" fit="cover" muted="muted"/>
  <video src="file_…" x="0" y="0" width="1920" height="1080" fit="cover" muted="muted"/>
  <text x="160" y="820" width="1200" font-size="64" color="#0F172A">Built for the long haul</text>
  <text x="160" y="910" width="1200" font-size="28" color="#475569">Available now</text>
</content>
XML
```

**6. Cut on the timeline, in a second call.** N bars at different `startMs`
across N clips IS the cut — outside its bar a clip's node is hidden, not
frozen, so the shots never fight:

```
moda canvas edit CANVAS_REF --file - <<'JS'
update('n1', { fillVideoTrimStartMs: 500, fillVideoTrimEndMs: 3500 });   // fill first…
motion.page('p_a', { durationMs: 9000 }, (t) => {
  t.video('n1', { startMs: 0,    endMs: 3000 });                          // …then the bar
  t.video('n2', { startMs: 3000, endMs: 6000 });
  t.video('n3', { startMs: 6000, endMs: 9000 });
  t.recipe('n4', 'recipe-reveal-line', { at: 6200 });
  t.effect('n5', 'opacity-fade-in', { startMs: 7000, durationMs: 500 });
});
JS
```

Trim, speed and loop live on the FILL (`fillVideoTrimStartMs`,
`fillVideoPlaybackRate`, `fillVideoLoop`) and never on the bar — passing
`offsetMs`/`rate`/`loop` to `t.video` is a hard error naming the fill field
instead. Set the fill first: the bar re-derives from it on every call. Model
duration floors overshoot short beats by design — *generate long and trim* is
the normal move.

**7. Deliver.** `moda export CANVAS_REF --format mp4 --page 1 -o teaser.mp4`,
the live link first. If they also want a still for a deck or a PDF, do NOT
export this page — build the still on its own page from a product image, or
hand over one of the source stills.

## Recipe 3 — Social ad

Platform-size canvas → one generated clip as a full-bleed video fill →
headline and CTA in the brand's type inside the safe zone → per-platform mp4.
Sizes and safe areas come from the moda-social family — load `moda-social`
or its platform child; everything about the still formats there still holds,
and only the export format changes.

**1. Canvas at the exact platform size**, animation category:

```
moda canvas create --name "Spring ad — 9:16" --size 1080x1920 --pages 1 --category animation
```

**2. Draft the clip in the right shape.** Ask for the aspect ratio the frame
needs — a 16:9 clip cropped to 9:16 loses the composition the model built:

```
moda media generate-video --prompt "Slow vertical drift over sunlit fabric texture, warm morning light, gentle parallax, no text, no faces" \
  --model veo-3.1-lite --duration 4 --resolution 720p --aspect-ratio 9:16 --no-generate-audio -o ad-draft.mp4
```

Verify, fix, then take the hero render at the length the ad needs — a
6-second feed spot on Veo 3.1 Lite at 1080p is the usual shape. Keep it
silent unless the ad is genuinely sound-on: feeds autoplay muted, and on
every Veo tier audio is a price axis.

**3. Compose inside the safe zone.** Footage full-bleed to the edges, type
and CTA inside — on 1080×1920 that is x 120–840, y 252–1742 for a normal
post (a TikTok ad reserves from y 1400 down):

```
moda canvas markup CANVAS_REF --file - --page p_a <<'XML'
<content font-family="…the kit's title family…">
  <video src="file_…" x="0" y="0" width="1080" height="1920" fit="cover" muted="muted"/>
  <rectangle x="0" y="1100" width="1080" height="820" fill="#0F172A" opacity="0.55"/>
  <text x="120" y="1240" width="720" font-size="84" color="#F8FAFC">One line that lands</text>
  <text x="120" y="1500" width="720" font-size="34" color="#F8FAFC">The supporting line</text>
  <rectangle x="120" y="1600" width="420" height="96" corner-radius="48" fill="#22C55E"/>
  <text x="120" y="1628" width="420" font-size="34" color="#052E16" text-align="center">Shop the drop</text>
</content>
XML
```

The scrim rectangle is the difference between legible type and unreadable
type over moving footage — footage brightness changes frame to frame, so
contrast that passes on frame one can fail by frame 60.

**4. Motion, second call**: the clip's bar for the page's length, the
headline in on a line reveal, the CTA last.

```
moda canvas edit CANVAS_REF --file - <<'JS'
motion.page('p_a', { durationMs: 6000 }, (t) => {
  t.video('n1', { startMs: 0 });
  t.recipe('n3', 'recipe-reveal-line', { at: 600 });
  t.effect('n4', 'opacity-fade-in', { startMs: 1600, durationMs: 500 });
  t.effect('n6', 'scale-in', { startMs: 2400, durationMs: 400 });
  t.effect('n6', 'pulse', { startMs: 3200 });
});
JS
```

**5. Per-platform output.** A second platform size is a second PAGE resized
in place (the page-resize recipe in references/edit-code.md: group the page's
nodes, set the page's width/height, scale the group to fit) — clips are
`fit="cover"`, so they refill the new frame, but re-check the new size's safe
zone, and re-place the type rather than letting it scale into it. Then one
export per page, since mp4/gif require `--page`:

```
moda export CANVAS_REF --format mp4 --page 1 -o ad-9x16.mp4
moda export CANVAS_REF --format mp4 --page 2 -o ad-1x1.mp4
```

Reuse the SAME clip across sizes wherever the framing survives the crop —
re-generating per platform buys nothing when the viewer reads the footage
identically. Re-generate when the crop actually breaks the composition.

## Recipe 4 — Animated display banner

A 3-frame animated banner outperforms a static one, so plan motion from the
first sketch rather than as polish. Everything the ads reference says about
the static piece still holds — the IAB sizes, the Rule of One, per-size
composition, the button-shaped CTA 8–10px off every edge — and only the
timeline and the export format are new. Nothing here is generated: on a
canvas of a few tens of thousands of pixels, solids, gradients, shapes, type
and shader fills are what the placement can afford.

**1. Canvas at the placement's exact size**, animation category, one page per
size:

```
moda canvas create --name "Spring banner — 300x250" --size 300x250 --pages 1 --category animation
```

**2. Three frames, one message.** The reliable structure, ~6–9s total inside
the typical 15s / 3-loop network cap:

1. **Hook frame (~1–1.5s)** — headline or hero, brand tucked in a corner.
2. **Detail frame (~1–1.5s)** — sub-headline, proof point, or product detail.
3. **Brand + CTA frame** — holds indefinitely. This is what a paused viewer
   clicks.

**3. Author every frame's elements in one apply**, stacked — the timeline,
not z-order, decides what is on screen:

```
moda canvas markup CANVAS_REF --file - --page p_a <<'XML'
<content font-family="…the kit's title family…">
  <background fill="#0F172A"/>
  <text x="20" y="80" width="260" font-size="30" font-weight="700" color="#F8FAFC">Ship it Friday</text>
  <text x="20" y="80" width="260" font-size="22" color="#CBD5E1">Teams onboard in a day</text>
  <image src="file_…" x="20" y="20" width="110" height="34" fit="contain"/>
  <rectangle x="20" y="176" width="150" height="44" corner-radius="22" fill="#22C55E"/>
  <text x="20" y="189" width="150" font-size="18" font-weight="600" color="#052E16" text-align="center">See the demo</text>
</content>
XML
```

**4. Motion, second call.** `t.setLifetime` is what takes a frame's elements
off screen when its beat ends (LEAF nodes only); the brand mark and CTA get
no lifetime, so they land and stay:

```
moda canvas edit CANVAS_REF --file - <<'JS'
motion.page('p_a', { durationMs: 7000 }, (t) => {
  t.setLifetime('n2', { startMs: 0, endMs: 1400 });                        // hook headline
  t.recipe('n2', 'recipe-rise', { at: 100, durationMs: 500 });
  t.setLifetime('n3', { startMs: 1400, endMs: 2800 });                     // detail line
  t.effect('n3', 'opacity-fade-in', { startMs: 1400, durationMs: 400 });
  t.effect('n4', 'opacity-fade-in', { startMs: 2800, durationMs: 400 });   // wordmark — no lifetime
  t.effect('n5', 'opacity-fade-in', { startMs: 3200, durationMs: 400 });   // CTA button — no lifetime
  t.effect('n6', 'opacity-fade-in', { startMs: 3200, durationMs: 400 });   // CTA label — no lifetime
});
JS
```

Type slides or fades; it never bounces (elastic easings read as cheap). Move
one thing per beat — simultaneous motion on a small canvas is chaos. Once
brand and CTA land, nothing moves: the user needs a stable click target.

**5. Watch the file-size budget.** Networks cap initial load around 150KB,
total ~2.2MB, and a single hero photo can spend 80–120KB on its own. Solid
color, gradients, shapes, type, and generated patterns are nearly free;
reserve photography for when it IS the ad, and prefer a product silhouette or
pack shot over scenic imagery. A shader page background is another cheap way
to buy motion.

**6. Deliver.** One export per page, since mp4/gif require `--page`:

```
moda export CANVAS_REF --format gif --page 1 -o banner-300x250.gif
```

Live link first, then the files. A second placement is a second PAGE resized
in place (the page-resize recipe in references/edit-code.md), re-composed for
its shape rather than scaled — a 728×90 is a horizontal lockup, not a
squashed 300×250, and its three beats carry one line of copy each.

Unsure which file an ad network takes? `moda ask "does an ad network want a
gif or an mp4 for an animated display banner?"`.

## What every recipe inherits

- **Static exports of these pages preserve poster frames, not clip motion.**
  If a placement warned `video_poster_unavailable`, that clip's rectangle is
  blank in png/jpeg/pdf/pptx. For a PDF or deck, use the poster still when it
  serves the design, or use a generated still, product photo, or shader fill.
- **A page with no animation rejects `no_animation`** on mp4/gif. That is the
  honest answer, not a retry: deliver the still and the link.
- **Never ask a video model for text.** Headlines, prices and CTAs are canvas
  type over the clip; that is the whole point of these recipes.
- **One bar per node.** Calling `t.video` again on the same node REPLACES its
  bar (which is also how you retime one).
- **Pin the knobs every time** (references/video.md): explicit
  `--duration`, the resolution the pass needs, one matter-of-fact line about
  what you're rendering, the usage receipt afterwards.
