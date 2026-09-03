---
name: moda-video-demo
description: >-
  Demo video of a feature YOU just shipped: Claude drives your dev server,
  records it, and Moda returns a branded canvas + mp4. Needs a running
  app. Not for footage you already have.
argument-hint: "[what to demonstrate] [--repo <path>] [--url <dev server>]"
allowed-tools: Bash, Read, Glob, Grep
---

<!--
A PROJECT skill, deliberately not in moda-cli/skills-taxonomy.json.

Two reasons it is not shipped in the roster yet. The roster's description mass is
a HARD cap that maps to real host truncation, so a new claim has to displace an
old one — and displacing a shipped format skill's routing to make room for this
would be the wrong trade. More importantly the output quality is not yet good enough to
route external users to: framing, caption selection and pacing are all still
being tuned, and a roster entry is a promise that the result is worth their turn.

It graduates into the roster when the output is good, and the budget gets
rebalanced deliberately at that point rather than quietly now.
-->

# moda-video-demo

<!-- moda:banner -->
**PREREQUISITE — load `moda-core` once per session** (step-0, write contract,
free/metered map). Already loaded? Skip ahead. If you cannot load it, the
non-negotiables: run `moda doctor --json` before anything; `moda brand list`
before creating; writes that pin a revision use your last read's — on
`stale_revision`, re-read and retry once (it heals); send the canvas link the
moment it exists; stuck or failed? `moda ask "<question>"` — free and fast,
never guess.
<!-- /moda:banner -->

You are making a demo video of a feature by **driving the app and recording it**.
There is no file to upload and nothing to screen-record by hand.

Publishing uses ordinary `moda` verbs, so it works for any account.

## The one rule that is not negotiable

**Never drive a production target without explicit approval.** The gate keys on the
TARGET, never on the flow — do not try to judge whether a demo is "read-only". It
cannot be judged reliably inside someone else's product, and a demo of clicking
Delete is a legitimate demo.

| Target | Action |
|---|---|
| `localhost`, `127.0.0.1`, `*.test`, `*.local` | drive it |
| a host naming dev / staging / preview / qa | drive it |
| anything else | **STOP and ask**, naming the host, before any click |

A capture creates, renames, shares and deletes real things. Approval comes before
execution, not after.

## 1 · Read the repo — do not ask the human yet

Work out how to reach the app from the repo itself, in this order. Stop at the
first rung that works:

1. **Already running?** Probe the usual ports (`curl -s -o /dev/null -w '%{http_code}'`).
2. **A start command?** `package.json` scripts, Makefile targets, Procfile, README quickstart.
3. **How do its own tests sign in?** Look for `*.setup.ts`, `playwright.config.*`,
   an `e2e/` directory. A programmatic sign-in the test suite already uses is
   reproducible and safe.
4. **Only now**, surface what you could not establish and ask.

**Prefer the app's own test auth over the developer's live browser session.** It is
more reproducible, dramatically safer, and the same pass that finds the login
usually finds the seed command — which is where determinism comes from.

Report what you found before proceeding: the target, the auth strategy, and
anything the repo did **not** establish. Do not paper over a gap.

## 2 · Author the flow blind, then repair it

Write the shortest sequence of steps that demonstrates the feature, using
Playwright locators. You are authoring without having seen the page, so **expect to
be wrong** — measured first-pass rate is near zero, and measured convergence is one
repair turn.

The single most common miss: assuming a nav item is a `link` when the app builds
it as a `button`. The accessible NAME is usually right; the ROLE usually is not.

On failure, re-author from an **accessibility snapshot of the page at the moment it
failed** — not from a stack trace. Give yourself the failing step, what did execute,
the current URL, and that snapshot. Return a corrected FULL flow.

If the app is not answering at all, **stop**. The repair loop fixes wrong selectors
and unexpected modals; it cannot fix a server that is down, and retrying burns a
turn per attempt to rediscover the same refusal.

## 3 · Reset, then record the real take

**Probe and capture are different runs.** Once the flow passes, discard that
browser entirely and start a fresh context for the recording.

This is not tidiness. If they were one run, the recording would contain the failed
attempts and the wrong turns taken while searching for a flow that works — and
everything downstream reads that recording as a record of what the demo IS.

While recording, keep for every action: **when it happened, what it targeted, where
that target's box was, and what it is called.** That record is what becomes the
captions and the camera. Get it from the locator you resolved, at the moment you
clicked — never reconstructed afterwards from memory, which is narration.

Glide the cursor to each target rather than teleporting, dwell about a second before
clicking, and hold after so the result is legible.

## 3.5 · Decide which KIND of demo this is

It changes the defaults, so decide before scripting. Read
`references/what-good-looks-like.md` — three published demos, measured.

**An OUTCOME demo** (ask for a thing, watch it appear): music from the first
frame, **no voiceover**, **no per-step captions** — at most a title, a transition
and a closer — and a hard cut out of every zoom. That is unanimous across the
references, and it is what a marketing demo looks like.

**A NAVIGATION demo** (find the setting three levels deep): where to click IS the
content, so captions earn their place and narration may too. No reference
attempts one, so nothing there disproves them — do not drop them by analogy.

Either way: music from 0s, zoom held ~0.5s and cut out of, and a logo/CTA card at
the end. Those three are unanimous and genre-independent.

## 4 · Write the script, and show it BEFORE you publish

One line per action. Write them yourself — a template produces
*"Start by opening Open the user menu"*, which is what happens when you wrap a
verb around a label that is already imperative.

Then **show the person the script and wait**, as a numbered list with each line's
measured spoken length against the time it has. This is the only review step in
the flow, and it is deliberately about MEANING, not geometry: a correct log does
not mean a good story, and their read of what mattered should overrule yours.
Fixing a line is a sentence to you; the video is regenerated from it.

**A line has to fit the gap before the next line starts.** The video cannot be
stretched to make room — re-pacing mid-clip needs an export scope that does not
exist yet — so the script is written to the footage, not the other way round.
`narrate()` reports the overrun per line; shorten those before publishing.

```bash
node -e "const {narrate}=require('./src/narrate.js');            # in moda-cli/demo-capture
  const clip=require('<outDir>/<id>.timeline.json');
  const r=narrate({clip, mp4:'<outDir>/<id>.mp4', outDir:'<outDir>', id:'<id>',
                   lines:['…one per action…']});
  console.log(r.report);"
```

Skip narration entirely if they would rather have a silent clip — say so and move on.

## 5 · Compile and publish

Read `references/capture.md` before this step. **Do not hand-write the markup or
the camera program.** A compiler owns the caption windows, zoom planning,
centre-pivot compensation, easing names and millisecond rounding, and each of
those has a silent failure mode. The reference carries the timeline shape and
the traps.

> The compiler and the runner it belongs to are not in this distribution yet —
> this skill ships ahead of them. Until they do, the steps below describe what
> the pipeline does rather than a tree you can run.

`publish-take.mjs` uploads the **narrated** cut when one exists. The audio
survives the export because the clip is placed as an un-muted video fill
(`AGENT_VIDEO_FILL_MUTED = false`) and the server executor muxes audible
video-fill audio unconditionally — so the voiceover rides the recording and needs
no composition audio clip.

Six verbs today: `file upload` → `canvas create --category animation` →
`canvas markup` → `canvas read` (for the node id) → `canvas edit` (camera and
caption tracks, ONE call) → `export --format mp4 --page 1`.

Send the canvas link the moment it exists: the mp4 is the deliverable, the canvas
is where they edit it.

**Verify rather than trust.** `ok: true` is also what a silently dropped track
returns. Read the canvas back and confirm the clip node and the animation tracks
are actually there before reporting success.

## Known limits — say these plainly, do not oversell

- **Mid-clip waits still play at 1×.** The leading load is trimmed at capture, but
  a spinner *between* two actions needs a rate change the export cannot request yet.
- **Punch-ins near a frame edge do not centre** — the camera stops flush rather
  than exposing the page behind the recording. Reported as `zoom_framing_clamped`.
- **No brand kit is applied yet.**

## Not this skill

Footage the user already has → there is no upload lane; say so. Animating a logo or
a design → `moda-video-clip`. Motion on an existing canvas → `moda-video-motion`.
