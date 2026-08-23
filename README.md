# Dr3amy Pages — Cloudflare Worker (multi-tenant, storage-only GitHub)

Every page is served from `dr3amy.creepers.pro` by this ONE Worker.
GitHub is used purely for storage — nobody needs GitHub Pages turned on.

```
dr3amy.creepers.pro/publish.html   (the uploader, works for anyone)
      │
      │  user pastes their own username + token
      ▼
GitHub repo "dr3amy-pages" (each user's own, storage only)
      │  p/<slug>/index.html
      ▼
Worker fetches raw.githubusercontent.com/<user>/dr3amy-pages/main/p/<slug>/index.html
      │
      ▼
dr3amy.creepers.pro/<user>/<slug>/   ← what visitors actually see
```

## Why this needs a Worker (not plain Pages/GitHub Pages)

Static hosting alone can't route `dr3amy.creepers.pro/<any-username>/<slug>/`
to a *different* GitHub repo per request — that routing logic is exactly
what `worker.js` does. This is the one legitimately-necessary bit of
"backend."

## Deploy — entirely from an iPad, no terminal needed

Cloudflare's dashboard has a browser-based code editor, so `wrangler`
(which needs a terminal) isn't required:

1. On iPad Safari, go to the Cloudflare dashboard → **Workers & Pages** → **Create** → **Create Worker**.
2. Name it `dr3amy-pages`, click **Deploy** to get a placeholder live.
3. Click **Edit code** (opens the browser-based editor).
4. Replace the default code with the contents of `worker.js` from this zip.
5. You also need the static files (`public/index.html`, `public/404.html`, `public/publish.html`, `public/templates/*`) attached as **Assets**:
   - In the Worker's editor view, look for **Assets** in the left sidebar (or Settings → Bindings → Add → Assets on newer dashboard versions).
   - Upload each file from `public/` into that assets panel, preserving the folder structure (`templates/minimal.html`, `templates/links.html`).
   - Bind them with variable name `ASSETS` (must match what `worker.js` expects) and set "not found" handling to serve `404.html`.
6. **Save and deploy.**

## Attach the custom domain

Worker → **Settings → Domains & Routes** → **Add Custom Domain** →
`dr3amy.creepers.pro`. Since the `creepers.pro` zone is already on this
Cloudflare account, DNS gets wired automatically — no manual CNAME.

## Per-user setup (what each person does)

1. Create a **public** GitHub repo named exactly `dr3amy-pages`.
2. Create a fine-grained personal access token scoped to just that repo,
   with **Contents: Read and write**.
3. Go to `dr3amy.creepers.pro/publish.html`, enter their username, that
   token, pick a template or upload HTML, choose a path, hit **Publish**.
4. Live instantly at `dr3amy.creepers.pro/<their-username>/<slug>/`.

No GitHub Pages, no per-user DNS, no per-user domain — the repo is only
ever read from as raw file storage.

## Notes

- If a user's repo is private, the raw-content fetch will 404 (raw.githubusercontent.com
  needs a public repo, or you'd need to pass a token server-side, which
  reintroduces exactly the secret-handling problem this design avoids).
  Keep `dr3amy-pages` repos public.
- Responses from GitHub are cached at the edge for 60s (`cf.cacheTtl`), so
  a page update can take up to a minute to reflect — lower that in
  `worker.js` if you want faster propagation at the cost of more requests
  to GitHub.
- Nothing here needs `wrangler` — the whole flow above is dashboard +
  Safari only.
