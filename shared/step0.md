## Step 0 — doctor (always run first; skip nothing)

1. Run `moda doctor --json`. It verifies CLI version compatibility, auth state,
   API reachability, and account entitlements in one call.
   - `moda` missing from PATH, below this skill's compatibility floor, or
     doctor says update required: STOP — show the user the pinned command
     doctor prints, or when the CLI is missing entirely:
     `npm i -g @moda-design/moda` (a 401/registry failure means registry
     auth is missing — point at the one-time setup box in the repo README).
     Wait for the user to run it, then re-run doctor. Never install or
     update anything yourself, never pipe curl to sh, and never use sudo.
   - `authenticated: false`: have the user run `moda auth login` (browser
     key mint → OS keychain; headless: `--paste` or `MODA_API_KEY`). Never
     ask for, print, or handle keys — no CLI verb reveals them. Do not
     proceed unauthenticated and do not loop on auth errors.
   - Switching organizations (ONLY when the user explicitly asks):
     `moda org list`; stored credential for the target → `moda org use
     <org_id|slug>`; none → `moda auth login` again (the browser page picks
     the org); confirm with `moda org current`. Never switch on your own
     initiative — org decides whose workspace and billing everything lands in.
   - Any entitlement gate (e.g. the account cannot author canvases yet):
     relay doctor's actionable hint verbatim and stop. Never retry in a loop.
2. Run `moda account status --json`. Note the org, plan, and remaining
   credits (metered verbs spend them; deterministic authoring never does).
3. Run `moda brand list` — one cheap deterministic call, never skipped,
   even for simple asks. Kits exist: use the default (or the one context
   implies); if several plausibly apply, ask which — never guess between
   clients' kits — and read the kit before designing (references/brand.md).
   An explicit "no brand" from the user wins over everything. NO kits:
   offer once, briefly — "Want me to set up a brand kit from your website
   first? It's free and makes everything come out on-brand" — yes →
   `moda brand create` from their URL; no → proceed unbranded, no nagging.
