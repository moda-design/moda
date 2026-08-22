# Static ads — the IAB set, per-size composition, and stopping power

## The size table

| Size | Name | Category | Notes |
|---|---|---|---|
| 300×250 | medium rectangle | `web-ads` | the workhorse; design the MASTER here |
| 728×90 | leaderboard | `web-ads` | above the article — hostile, one line only |
| 160×600 | skyscraper | `web-ads` | sidebar tall |
| 300×600 | half page | `web-ads` | the roomy one |
| 320×50 | mobile banner | `web-ads` | type only |
| 320×100 | large mobile banner | `web-ads` | one line plus a small mark |
| 970×90 | large leaderboard | `web-ads` | premium placement |
| 970×250 | billboard | `web-ads` | the only size with room for imagery |
| 336×280 | large rectangle | `web-ads` | in-article |

A bare "banner ad" request means build BOTH 728×90 and 300×250 — that pair is
what a trafficker expects when no sizes are named.

Platform-native paid formats: IG story ad 1080×1920 (CTA chrome reserves from
y 1400), IG feed ad 1080×1080 or 1080×1350, Facebook feed ad 1200×628. The ad
noun beats the platform noun: "an Instagram ad" is this lane, not the organic
platform child, and it borrows that platform's safe areas.

## The idea, before any layout

Write it in one sentence: "For [audience], [brand] is the [category] that
[single claim]." Then the **Rule of One** — one audience, one promise, one ask.
Kill every secondary message before it reaches the canvas.

**Stopping power before clarity**: one element dramatically larger than
everything else, colour that violates the page it will sit on, a deliberate crop,
exactly one focal point. The squint test: blur the draft — if it still shows what
it is for and where the eye lands, it works.

Headline and visual are ONE idea. If the headline works pasted on a different
image, the lockup is weak. Never describe the image in the headline.

Run the brand's distinctive assets — logo, colours, device, tagline — at real
scale in every concept. Multiple concepts get different playbooks
(product-as-hero, before/after, visual metaphor, typographic manifesto,
category-code reversal, testimonial, problem-solution), not variants of one.

## Per-size composition

The master is a design; the other sizes are **re-compositions of the same
message**, never a squashed copy.

- **300×250 (master)**: hook, brand, CTA stacked. Everything that follows is a
  reduction of this.
- **728×90 / 970×90**: horizontal lockup — headline left, CTA right, brand mark
  small. One line of copy. No supporting text survives here.
- **160×600 / 300×600**: vertical stack with the CTA at the bottom; the tall
  formats are where a product silhouette earns its place.
- **320×50 / 320×100**: type only. Four or five words plus a button-shaped CTA;
  4–6px of clearance and never touching an edge.
- **970×250**: the one size where photography or a generated field can carry the
  frame — everything else prefers solid colour, gradients, shapes, type and
  generated patterns, because imagery rarely resolves at ad sizes.

Universal: keep type and CTA 8–10px off every edge (networks add a border at
serve time). The CTA is always button-shaped and the highest-contrast element on
the piece — "See the demo", never "Learn more".

## Delivery

One canvas, one page per size, exported together: a multi-page png export arrives
as a **zip**, which is exactly what the trafficker wants. Applies to one canvas
stay serial — a parallel batch across many pages shares one revision pin and
loses to `stale_revision`.

## Not this lane

Animated or HTML5 ads → moda-video (the motion is authored on an animation
canvas and exported as gif/mp4). Organic posts and channel art → the moda-social
platform children. Markup grammar: `references/markup.md`; export mechanics:
`references/export.md`.
