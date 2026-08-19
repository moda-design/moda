## Step 0 — doctor (always run first; skip nothing)

1. Run `moda doctor --json`. It verifies CLI version compatibility, auth state, API reachability, and account entitlements in one call.
   - `moda` missing from PATH, below the server minimum (doctor reports
     `version.below_minimum`), or update required: STOP — your stop reply
     MUST quote the install command verbatim (the pinned command doctor
     prints; CLI missing entirely: `npm i -g @moda-design/moda`; a 401 =
     a stale private-registry override in their npm config). Never stop
     without the command; no Mermaid/HTML/prose stand-in replaces the
     stop. Wait for the user to run it, then re-run doctor. Never install
     or update anything yourself, never pipe curl to sh, and never sudo.
   - `authenticated: false`: have the user run `moda auth login` (browser key mint → keychain; headless: `--paste` or `MODA_API_KEY`).
     Never handle or print keys. No unauthenticated work; no auth-error loops.
   - Switching organizations (ONLY when the user explicitly asks):
     `moda org list`; stored credential for the target → `moda org use
     <org_id|slug>`; none → `moda auth login` again (the browser page picks
     the org); confirm with `moda org current`. Never switch on your own
     initiative — org decides whose workspace and billing everything lands in.
   - Any entitlement gate (e.g. the account cannot author canvases yet): relay doctor's actionable hint verbatim and stop. Never retry in a loop.
2. Run `moda account status --json`. Note the org and plan.
3. Run `moda brand list` — one cheap deterministic call, never skipped. Use a kit unprompted only on a real
   signal: ONE kit, one marked `(default)`, one remembered via `moda brand use`, or one the request names
   outright ("the Acme deck" → the Acme kit). Otherwise ASK — topic-fit alone is never the signal, and
   near-identical names (Acme, Acme 2) mean ask even when named. Read the kit, then BIND it
   (`moda canvas create --brand …`, or `moda canvas brand` later) and NAME it at hand-over
   (references/brand.md): unbound, the canvas opens in Moda with an empty brand-kit dropdown. More work
   coming? Offer `moda brand use KIT` (`--local` for this repo). An explicit "no brand" wins. NO kits: offer
   once — "Want me to set up a brand kit first? It's free" — yes → `moda brand create`; no → unbranded.
4. Note whether you can VIEW images: screenshot review assumes vision. A vision-less harness follows the degraded verify loop in references/reading-and-verifying.md.
