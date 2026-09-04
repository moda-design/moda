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

**One command does the whole pipeline.** Your job is to point it at the right
target and to read what it tells you — not to rebuild it. Discovery, curation,
validation, recording, pacing, the camera, captions, the critique loop and
publishing all live in `demo-capture`.

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

## 1 · Find the app — do not ask the human yet

Work out how to reach it from the repo itself, stopping at the first rung that
works:

1. **Already running?** Probe the usual ports (`curl -s -o /dev/null -w '%{http_code}'`).
2. **A start command?** `package.json` scripts, Makefile targets, Procfile, README quickstart.
3. **How do its own tests sign in?** `*.setup.ts`, `playwright.config.*`, an `e2e/`
   directory. A programmatic sign-in the test suite already uses is reproducible
   and safe.
4. **Only now**, surface what you could not establish and ask.

Prefer the app's own test auth over the developer's live browser session: more
reproducible, dramatically safer, and the pass that finds the login usually finds
the seed command, which is where determinism comes from.

Report the target, the auth strategy, and anything the repo did NOT establish.

## 2 · Find the tool, then check the machine

It installs with this skill, as `demo-capture/` beside this file. Locate it once
and keep the path:

```bash
DC=
for c in "$CLAUDE_PLUGIN_ROOT/skills/moda-video-demo/demo-capture" \
         ~/.claude/skills/moda-video-demo/demo-capture \
         ~/.agents/skills/moda-video-demo/demo-capture \
         ~/.cursor/skills/moda-video-demo/demo-capture \
         .claude/skills/moda-video-demo/demo-capture \
         ~/.claude/plugins/*/moda*/skills/moda-video-demo/demo-capture \
         ~/.claude/plugins/*/*/moda*/*/skills/moda-video-demo/demo-capture \
         ./moda-cli/skills/moda-video-demo/demo-capture; do
  [ -d "$c" ] && DC=$c && break
done
if [ -z "$DC" ]; then
  echo "demo-capture not found — it installs beside this SKILL.md; reinstall the skill"
else
  node "$DC/doctor.mjs"
fi
```

Names what is missing — node, ffmpeg, the browser, both CLIs, whether `moda` is
signed in — before anything is recorded. Three states per row: present, missing,
or unknown. Fix what it names; do not start a capture around a gap.

## 3 · Run it

```bash
: "${DC:?run step 2 first — it resolves demo-capture and sets DC}"
node "$DC/run.mjs" "<what to demonstrate>" <url> --name <slug> [--no-auth] \
  [--attempts 2] [--publish "<Title>"]
```

`--attempts 2` lets it re-discover when the first flow is not worth filming.
Without `--publish` it stops after the critique and prints the command to
publish, which is the right shape when you want to look first.

**Read its report rather than summarising it.** Everything below is measured, and
each line is either a number or an explicit "not measured" — never a silent pass:

| It says | It means |
|---|---|
| `not recording this flow` | the walk found the demo is not worth filming; it is re-discovering |
| `⚠ step N returns the page to…` | the flow revisits a state the viewer has seen |
| `⚠ N of M clicks land on one row` | a tour of one widget, not a demo of a product |
| `⚠ FROZEN — N%` | that share of the finished video is a still image |
| `⚠ THE CAMERA IS NOT SHOWING THE RESULT` | the shot is framed on the input, not the output |
| `⚠ PAYOFF IS HARDER TO READ` | the result is less legible than what it replaced |
| `⚠ broken image` / `dev error overlay` | in every frame; record against a production build |

A run that refuses to record is doing its job. Do not work around it by
hand-writing a flow — find a better goal, or say the app has no good demo for
this one. That is a real answer.

## 4 · Say what it actually produced

Give the human the canvas URL and the mp4 path, the score, and the findings that
survived. **Do not oversell a mediocre take.** If the report says two thirds of
the video is a still image, say that. The score is a proxy for polish, not for
whether the flow was worth filming — a clean video of a pointless sequence can
outscore a rough video of a good one, so trust the flow findings over the number.

## Known limits — say these plainly, do not oversell

- **Mid-clip waits still play at 1×.** The leading load is trimmed at capture, but
  a spinner *between* two actions needs a rate change the export cannot request yet.
- **Punch-ins near a frame edge do not centre** — the camera stops flush rather
  than exposing the page behind the recording. Reported as `zoom_framing_clamped`.
- **No brand kit is applied yet.**
- **The compile step wants a studio checkout** for the loop's camera lane only.
  Publishing does not. Without one, `iterate` says the zoom checks are
  "not measured" rather than passing them.


## Not this skill

Footage the user already has → there is no upload lane; say so. Animating a logo or
a design → `moda-video-clip`. Motion on an existing canvas → `moda-video-motion`.
