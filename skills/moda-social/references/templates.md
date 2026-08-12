# Team templates — start from the design the team already approved

A team template is a canvas someone on the team marked as the approved
starting point for a recurring artifact: the QBR deck, the launch post, the
customer one-pager. Starting from one is how the output comes out looking
like the team's other work — the brand-consistency argument one level up
from a kit: it carries the layout and structure, not just the tokens.

## When to check (one cheap read, before designing)

The ask matches a recurring artifact type — something a team plausibly
produces again and again (a QBR or board deck, a launch or announcement
post, a customer/product one-pager) — or the user says "our template", "our
usual format", "what do we have". Check templates BEFORE designing from
scratch. One deterministic call; skip it for genuinely one-off asks (a quote
card, a novelty graphic).

## The two verbs (and why there are two)

```
moda template list                                # id, name, [category · N pages] — the browse
moda template pull --output /tmp/templates.json   # the SAME payload, thumbnails fetchable
```

`moda template list` is the model-safe browse. Signature material is scrubbed
from every byte it emits (`--output` included), so its `thumbnail_url` values
cannot be fetched — that is deliberate, not a bug. `moda template pull` is the
thumbnail read: it writes the raw payload, so the signed URLs still work.
Both accept `--limit` and `--cursor`.

## Look at the templates, don't pick by name

Names and categories don't tell you what a template LOOKS like. Same
discipline as brand logos (references/brand.md):

1. `moda template pull --output /tmp/templates.json`, then pre-filter with
   `jq '.data[] | {id, name, category, page_count, thumbnail_url}'` —
   category and page count do the cheap narrowing (a deck ask → `slides`
   templates; a social ask → `social`; a one-pager → a 1–2 page document).
2. Download the 2–4 plausible candidates:
   `curl -o /tmp/tmpl-1.png "<thumbnail_url>"`.
3. **View each image with your own vision** before choosing. A null
   `thumbnail_url` means nothing is rendered yet — judge that one on its
   name, category, and description, or skip it.

Signed thumbnail URLs are use-and-discard: never place one in markup, never
persist one, never hand one to the user. They expire.

## The decision

- **A template that fits the ask beats building from scratch.** Instantiate
  it: `moda canvas create --template cvs_… --name "Q3 QBR — Acme"`. The
  server makes a full copy; `--template` defines the size, page count, and
  category, so passing those flags with it is an error.
- The copy is a **regular canvas** — read it, then edit its content through
  the normal flow. Nothing about it is locked or linked back to the source.
- Want a copy of an EXISTING canvas rather than a template? `moda canvas
  duplicate CANVAS_REF --name "…"` is the pure as-is copy (no AI changes) —
  same idea, any canvas you can read.
- **None fit?** Say so in one line ("no team template matched, so I designed
  this fresh") and build from scratch per the usual design references
  (references/design-quality.md). Never force a bad-fit template.
- Tell the user which template you started from — it is a decision they may
  want to correct.

## Honest gaps

- The team may not have templates yet: an empty list is a normal answer, and
  the reply is one line, not an offer to go build a template library.
- The server may report this surface as unavailable (a 404) on an account
  where it is not enabled yet. Treat that exactly like "no templates" and
  move on — do not retry it, and do not mention it to the user.
- Templates are created in the Moda app (mark a canvas as a team template);
  there is no verb here that makes one.
