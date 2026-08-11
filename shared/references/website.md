# Building hosted websites — `moda site` and the moda.page runtime

A Moda site publishes to a public `https://<slug>.moda.page` URL. The lane is
deterministic and unmetered. This is a design surface: design quality matters,
not just valid HTML.

**v1 is static single-page sites**: one HTML document in, served as the site.
No extra routes, no server code, no logins, no databases — and **no
screenshot/visual-QA verb on this surface**. Say BOTH up front when a request
implies multiple pages or rendered-preview checks: offer supported embeds,
anchor-linked sections, and live-URL review instead, and say plainly when
something is out of scope — before building, not after.

## Verbs

```
moda site create --file page.html [--title "Name"]
moda site list [--limit N] [--offset N]
moda site show SITE_ID
moda site set-content SITE_ID --file page.html [--title "Name"]
moda site publish SITE_ID [--slug prefix]
moda site unpublish SITE_ID
moda site delete SITE_ID
```

- Site ids are plain UUIDs — take them from `create` / `list`; never invent
  or transform one.
- `create` stores the page but publishes nothing. The site has no URL until
  the first `publish`.
- `set-content` replaces the whole page (send the complete HTML document,
  not a diff). It does NOT touch the live site: the published page keeps
  serving the last publish until you run `moda site publish` again — the
  response's `has_unpublished_changes` flags exactly this. The edit loop is
  always save-then-republish. For read-modify-write safety pass
  `--expected-version N` (the `version` from your last `moda site show`); a
  409 `website_version_conflict` means the site changed since your read —
  re-read, re-apply, republish.
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

## Authoring the page

Write the HTML with your own tools as one **self-contained document**: inline
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

There is no screenshot verb on this surface. Verify by reviewing the HTML you
authored (read it back critically: hierarchy, spacing, responsive behavior,
contrast) and, after publish, by fetching the live URL when your harness can.
Fix, `set-content`, republish.
