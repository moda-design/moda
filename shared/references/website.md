# Building hosted websites — `moda site` and the moda.page runtime

A Moda site publishes to a public `https://<slug>.moda.page` URL. The lane is
deterministic and unmetered. This is a design surface: design quality matters,
not just valid HTML.

**Static multi-page sites**: HTML documents in, served as routable pages
(`/`, `/pricing`, …). No server code, no logins, no databases — offer
supported embeds and links instead, and say plainly when something is out
of scope. Visual QA is real: `moda site screenshot` renders draft pages at
desktop/tablet/mobile widths.

## Verbs

```
moda site create --file page.html [--title "Name"]   # starts with the homepage
moda site list / show / pages SITE_ID                # pages → paths, names, VERSION
moda site set-content SITE_ID --file page.html [--path /route] [--expected-version N]
moda site add-page SITE_ID --path /pricing --file page.html [--name Pricing]
moda site delete-page SITE_ID --path /route          # the homepage (/) is protected
moda site screenshot SITE_ID [--path /a /b] [--viewport desktop|tablet|mobile] [--format jpg|png]
moda site publish SITE_ID [--slug prefix]            # one publish covers ALL pages
moda site unpublish SITE_ID / delete SITE_ID
```

- Site ids are plain UUIDs — take them from `create` / `list`; never invent
  or transform one.
- `create` stores the page but publishes nothing. The site has no URL until
  the first `publish`.
- `set-content` replaces a page's complete HTML (never a diff): `--path`
  targets one route; omitting it writes the homepage/site-level content.
  Saves do NOT touch the live site — every page keeps serving the last
  publish until `moda site publish` runs again (`has_unpublished_changes`
  flags this). The edit loop is always save-then-republish. Pass
  `--expected-version N` (the `version` from `moda site pages`/`show`) for
  read-modify-write safety; 409 `website_version_conflict` → re-read,
  re-apply, republish. Adding a page that exists is 409
  `website_page_exists` (update it instead).
- `publish` returns the live URL — print it prominently. `--slug` is a
  first-publish hint only (the final slug gets a random suffix; the hint is
  ignored on republish). A `slug_taken` / `slug_invalid` error means pick a
  different hint, not retry the same one.
- `review_status: "pending_review"` on a publish means the site is published
  but held for review before it serves. Say so honestly: give the user the
  URL and tell them it goes live once approved — do not present it as
  already browsable, and do not loop waiting for approval.
- Publish-gate errors and what to do: `malicious_link` / `content_flagged`
  (422 — the content gate refused the page: fix or remove the flagged
  content, save, republish; never resubmit unchanged), `missing_homepage` /
  `artifact_too_large` (400 — the page is malformed or over the 20MB limit:
  shrink assets, re-host images in Moda), `free_publishing_disabled` (403 —
  the plan cannot publish: relay the hint, do not retry), quota codes
  (429 — publish has its own fair-use budget: wait, do not loop), and
  `website_already_published` (409 — fires only when two concurrent FIRST
  publishes race; another publish just won that race, so re-run publish and
  it succeeds onto the winner's row. Republishing a live site is always
  safe: same site, same slug, artifact rebuilt).
- A 403 `team_access_denied` on a site means your key's team lacks edit
  rights on this site — it is NOT an auth failure; do not re-run
  `moda auth login`.

## Authoring pages

Write each page with your own tools as one **self-contained document**: inline
`<style>` for CSS, minimal inline `<script>` for behavior. Do not add blanket
CSS resets or normalize rules (`* { margin:0 }` and friends) — the hosting
runtime provides a sane baseline; component-specific styles only. Mobile-first,
polished across desktop, tablet, and phone.

Typography: if a brand kit lists fonts, use them matched to role (heading font
for headings/display, body font for body/UI); never swap a brand font for a
"similar" one. Load non-brand fonts from Google Fonts with a `<link>`; system
fonts are fallbacks only. Avoid the overused defaults (Inter, Roboto, Open
Sans, Lato, Montserrat, Poppins, Raleway, Oswald, Nunito, Playfair Display)
unless the brand kit names them.

## Client-side libraries (self-hosted; third-party CDNs are blocked)

Published sites block third-party CDNs (cdnjs, jsdelivr, unpkg, …) — a script
from one silently breaks. Vetted libraries are self-hosted on Moda's CDN; add
only what the page needs, from these exact URLs:

- GSAP (core + ScrollTrigger; call `gsap.registerPlugin(ScrollTrigger)`):
  `https://cdn.moda.app/runtime-libs/gsap-3.15/gsap.min.js` and
  `https://cdn.moda.app/runtime-libs/gsap-3.15/ScrollTrigger.min.js`
- Swiper (prefer over hand-rolled carousels):
  `https://cdn.moda.app/runtime-libs/swiper-12.2.0/swiper-bundle.min.css` and
  `https://cdn.moda.app/runtime-libs/swiper-12.2.0/swiper-bundle.min.js`
- Chart.js: `https://cdn.moda.app/runtime-libs/chartjs-4.5.1/chart.umd.min.js`
- Lenis (smooth scroll; needs a rAF loop calling `lenis.raf(time)`):
  `https://cdn.moda.app/runtime-libs/lenis-1.3.23/lenis.css` and
  `https://cdn.moda.app/runtime-libs/lenis-1.3.23/lenis.min.js`
- Three.js (ESM import map — `three` →
  `https://cdn.moda.app/runtime-libs/three-0.184.0/three.module.min.js`,
  `three/addons/` → `https://cdn.moda.app/runtime-libs/three-0.184.0/addons/`;
  ~600KB, real 3D only; import map before your module scripts).

## Embeds & third-party content (strict allowlist)

An embed from any origin not listed below is silently blocked on the
published site. There is no generic embed — never emit another third-party
origin, even a mainstream one.

- Maps: Google Maps. Scheduling: Calendly.
- Forms / lead capture: a native on-brand `<form>` wired to a no-backend
  delivery (Web3Forms / Formspree / Formsubmit), or a hosted Tally / Google
  Forms / Typeform / Jotform iframe — prefer the native form.
- Newsletter: Mailchimp / Kit / Beehiiv.
- Contact: WhatsApp / Viber / Telegram / `tel:` / `mailto:` deep-links.
- Video: YouTube (`youtube-nocookie.com`) or Vimeo iframes; Cloudflare
  Stream for the user's own hosted videos.
- Payments: Stripe (Checkout / Payment Links).
- Analytics: Google Analytics (GA4 gtag only, never Google Tag Manager).

Asked for anything not on the list: do not emit it — say it is not supported
yet and offer the closest supported option or a plain link. For service,
local, or conversion businesses, proactively offer a contact, lead-capture,
or booking path even when not asked. Never invent embed URLs, access keys,
form IDs, or contact details — ask the user.

## Images & assets

Published sites block external image origins — never hotlink another site's
images. Use images that live in Moda: brand-kit assets, the user's uploads
(`moda file upload`, `moda file upload --from-url`), or generation
(`moda media generate-image`, metered). When recreating an existing site
from a URL, reuse its real copy/colors/fonts but re-host its images in Moda.

## Verify loop

`moda site screenshot SITE_ID --path /route --viewport mobile` renders the
DRAFT (saved) content — up to 3 pages per call, desktop/tablet/mobile, files
downloaded locally for your own vision. Check hierarchy, spacing, contrast,
and responsive behavior at desktop AND mobile before publishing; a
`js_disabled` capture is degraded (JS-off fallback) — re-capture before
judging animation-dependent layouts. 503 `render_capacity` is transient
(retry after a moment); 422 `website_render_too_heavy` is deterministic —
lighten the page. Fix, `set-content`, screenshot again, republish.
