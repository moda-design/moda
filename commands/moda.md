---
description: Design on Moda — routes to the right moda skill (deck, one-pager, social, diagram, website, brand, edit)
argument-hint: "[what you want made or changed]"
---

Route the user's request to the right Moda skill and follow it:

- A deck, slides, presentation, pitch, QBR, board update, "turn this into
  slides" → use the **moda-deck** skill.
- A one-pager, PDF, report (single OR multi-page), infographic, brief,
  handout, flyer, poster, or other print piece (menu, resume, certificate,
  invitation, business card), "make this look designed" → use the
  **moda-one-pager** skill.
- A social post, carousel, story, TikTok/IG/LinkedIn creative, static ad,
  banner ad, or channel header/cover → use the **moda-social** skill
  (animated ads are refused honestly with a static offer).
- A diagram, flowchart, org/architecture chart, 2x2 matrix, standalone data
  chart, wireframe, or a mockup of an app/site screen → use the
  **moda-diagram** skill (a diagram or chart destined for an existing
  deck/document canvas stays with moda-deck / moda-one-pager / moda-edit).
- A one-off standalone graphic with no platform attached — a quote card,
  "a simple graphic of X", a circle with a caption → use the **moda-social**
  skill (structural boxes-and-arrows → moda-diagram; print words like
  poster/flyer → moda-one-pager).
- A website, landing page, marketing site, portfolio, "put this on the web",
  or an existing moda.page site to change → use the **moda-website** skill
  (a printable/PDF one-pager stays with moda-one-pager).
- Brand kits — list/show/create a kit, "use our brand", "match our site",
  audit a canvas against the brand → use the **moda-brand** skill.
- A moda.app canvas URL / share link / `cvs_` id plus a change request →
  use the **moda-edit** skill.
- A recurring artifact that mentions team templates — "use our template",
  "our usual QBR format", "what templates do we have" → the matching
  artifact skill (**moda-deck** / **moda-one-pager** / **moda-social**),
  which checks the team's templates before designing from scratch.

If the request spans several (e.g. "an on-brand deck"), the artifact skill
leads (moda-deck) and pulls brand data per its references. If none fit,
say what the Moda skills can make and ask which the user wants.

Request: $ARGUMENTS
