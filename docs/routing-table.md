# Skill routing table — the adversarial contract

The nine skill descriptions are a mutual-exclusivity contract: for any
plausible ask, exactly ONE skill claims it. This table is the maintained
record of that contract — update it in the same commit as any description
change, and re-verify the rows that touch the changed skill. moda-help
mirrors this table at runtime: update BOTH in the same commit (validate
enforces that moda-help names every skill).

| User ask | Skill | Why / boundary rule |
|---|---|---|
| "Pitch deck for investors" | moda-deck | slides/presentation words |
| "Turn this into a 12-page annual report PDF" | moda-one-pager | claims multi-page documents explicitly |
| "An infographic about our metrics" | moda-one-pager | claims the word |
| "Poster of this quote" | moda-one-pager | print words (poster/flyer/menu/resume/…) always win — even for quote content |
| "Quote card" / "make a circle with a witty quote beneath it" | moda-social | the uncategorized-standalone lane: simple one-off graphics with no platform attached |
| "A simple graphic for X" | moda-social | same lane; digital one-off, no print word |
| "Instagram carousel about our launch" | moda-social | platform creative (png zip; LinkedIn carousel → one multi-page PDF) |
| "LinkedIn banner for my profile" / "static TikTok ad" | moda-social | platform surface — stills; the animated version of the same ad is moda-video |
| "Make a fun short video with our logo" / "animate our logo" | moda-video | generated video from brand assets (image-to-video, reference-guided) |
| "An animated ad / motion graphic / GIF of X" | moda-video | owns anything that renders to mp4/gif — moda-social keeps still formats |
| "Turn this canvas/page into a video" / "export this animation as mp4" | moda-video | canvas frame → motion, or animation-canvas mp4/gif export |
| "Upscale this video" | moda-video | the metered video-enhance lane |
| "A landing page for my product" | moda-website | live, hosted (*.moda.page) |
| "A mockup of our app's dashboard" | moda-diagram | a PICTURE of an interface — live page goes to moda-website |
| "Flowchart of our onboarding" / "2×2 of the landscape" | moda-diagram | structural boxes-and-arrows |
| "A bar chart of Q3 revenue" (standalone) | moda-diagram | standalone data charts — but destined for an EXISTING deck/document canvas → moda-deck / moda-one-pager / moda-edit |
| "Build a brand kit from our site" | moda-brand | kit lifecycle |
| "Here's the canvas URL — make the headline bigger" | moda-edit | existing-canvas change request |
| "Set up Moda for me" / "what can Moda do?" / "how do I switch orgs" / CLI errors | moda-help | meta-only; never claims authoring asks |
| "Set up Moda to auto-post blog articles to LinkedIn weekly" (automation/integration/scheduling asks) | moda-help | none-fit catcher: no automation surface exists — see the automation-vs-authoring boundary rule |

Boundary rules, stated once:

- **Structural vs decorative shapes**: moda-diagram is boxes-and-arrows
  intents only; a graphic that merely USES shapes (quote card, decorative
  visual, circle with a caption) is moda-social. This is the
  nearest-neighbor trap that misrouted "circle with a witty quote".
- **Quote card vs poster**: print words (poster, flyer, and the one-pager
  print umbrella) route to moda-one-pager regardless of content; the same
  quote as a digital one-off card is moda-social.
- **Mockup vs live page**: a picture of an interface is moda-diagram; a
  hosted page is moda-website.
- **Chart placement**: standalone data charts are moda-diagram; a chart
  inside an existing deck/document canvas stays with the canvas's skill.
- **Landing page**: "landing page" alone means the live hosted site
  (moda-website); "landing page mockup/design" means the picture
  (moda-diagram).
- **Motion vs stills**: moda-video owns anything that renders to mp4/gif —
  generated clips, animated ads/posts, logo animations, animation-canvas
  exports, video upscales. moda-social owns still deliverables and the
  platform sizing/safe-area rules. An "animated social post" is ONE owner:
  moda-video makes the motion (consulting social sizes for the aspect);
  it never bounces back mid-task.
- **Automation vs authoring**: "set up Moda to …" scheduling/integration
  asks are moda-help even when they name a platform whose creative rows
  belong to a format skill (the LinkedIn trap above) — the automation is the
  ask, and no such surface exists: honest gap, then offer the one-time
  artifact via its format skill. A single-deliverable ask (even a recurring
  topic, "our weekly post") stays with the format skill.
