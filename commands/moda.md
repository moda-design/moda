---
description: Design on Moda — routes to the right moda skill (deck, one-pager, brand, edit)
argument-hint: "[what you want made or changed]"
---

Route the user's request to the right Moda skill and follow it:

- A deck, slides, presentation, pitch, QBR, board update, "turn this into
  slides" → use the **moda-deck** skill.
- A one-pager, PDF, report, brief, handout, flyer, "make this look designed"
  → use the **moda-one-pager** skill.
- Brand kits — list/show/create a kit, "use our brand", "match our site",
  audit a canvas against the brand → use the **moda-brand** skill.
- A moda.app canvas URL / share link / `cvs_` id plus a change request →
  use the **moda-edit** skill.

If the request spans several (e.g. "an on-brand deck"), the artifact skill
leads (moda-deck) and pulls brand data per its references. If none fit,
say what the Moda skills can make and ask which the user wants.

Request: $ARGUMENTS
