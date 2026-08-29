# Dr3amy Pages — User Guide

[![License](https://img.shields.io/badge/license-Dr3amy%20Pages%20Attribution-blue.svg)](LICENSE)

Dr3amy Pages lets you publish a static HTML page to a live URL in seconds. There's no server and no deploy step — the app writes your HTML straight into a GitHub repo, and that repo is served at `dr3amy.creepers.pro`.

## 1. Sign in

You need a GitHub account to publish, since pages are stored in your own repo.

**Option A — Sign in with GitHub**
Tap **Sign in with GitHub** and authorize the app through GitHub's normal OAuth login.

**Option B — Sign in with a personal access token**
1. Tap **Sign in with a personal access token instead**.
2. Enter your **GitHub username**.
3. Generate a token (link provided in-app) scoped to a repo named `dr3amy-pages`, with **Contents: Read & write** permission.
4. Paste the token (`ghp_...`) and tap **Sign in with token**.

> If the `dr3amy-pages` repo doesn't exist yet on your GitHub account, create it first: Public, no README/.gitignore/license needed — the app will write files into it directly.

## 2. Your dashboard

Once signed in you land on **My Pages**, which shows:
- How many pages you've published (0 to start)
- The name of your storage repo (`dr3amy-pages`)
- A list of your published pages (empty until you publish your first one)

Tap **+ New Page** at any time to start another page.

## 3. Create a new page

On the **New Page** screen:

1. **Pick a starting point:**
   - **Minimal** — a bare centered HTML page (default)
   - **Link-in-bio** — links list layout
   - **Portfolio** — image/gallery layout
   - **Résumé** — document-style layout
   - **Event** — event announcement layout
   - **Coming Soon** — "Something's coming" page with an email capture form
   - **Blank** — empty editor
   - **Upload file** — drag or tap to upload your own `.html` file

2. **Set the path:** type a slug (e.g. `my-page`). This becomes your live URL:
   `dr3amy.creepers.pro/p/<your-slug>/`

3. **Edit the HTML:** the editor shows the full HTML for the selected template, ready to edit directly in the browser — no local tools needed.

## 4. Preview and publish

- Tap **Preview** to see how the page will render before it goes live.
- Tap **Publish** to write it to your GitHub repo.

Behind the scenes, publishing:
- Sends a `PUT` request to `https://api.github.com/repos/<you>/dr3amy-pages/contents/p/<slug>/index.html`
- Creates (or updates, if the slug already exists) `index.html` at that path in your repo
- Returns a success confirmation with a link to the file on GitHub

Your page goes live at `https://dr3amy.creepers.pro/p/<slug>/` within about **30–60 seconds**.

## 5. Manage your pages

Back on the **My Pages** tab, every published page is listed. From there you can:
- **View** — open the live URL
- **Edit** — reopen the HTML editor and re-publish changes
- **Delete** — remove the page from your repo

All of this can be done from a browser on any device — no terminal or local setup required.

## Quick reference

| Step | Action |
|---|---|
| 1 | Sign in with GitHub or a personal access token |
| 2 | Tap **+ New Page** |
| 3 | Choose a template or upload your own HTML |
| 4 | Set the path/slug |
| 5 | Edit the HTML in-browser |
| 6 | Tap **Preview** to check it |
| 7 | Tap **Publish** |
| 8 | Live at `dr3amy.creepers.pro/p/<slug>/` in ~30–60s |
