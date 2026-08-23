/**
 * Dr3amy Pages — Worker entrypoint
 * ------------------------------------------------------------
 * Every page on dr3amy.creepers.pro is served FROM HERE. GitHub is only
 * used for storage — nobody needs GitHub Pages turned on, and there is
 * no single "Dr3amy-Pages" repo. Each user has their OWN repo (named
 * exactly `dr3amy-pages`, any username), and this Worker fetches their
 * file straight from GitHub's raw content host and returns it as HTML.
 *
 * URL shape:
 *   dr3amy.creepers.pro/<github-username>/<slug>/
 *     → reads   raw.githubusercontent.com/<username>/dr3amy-pages/main/p/<slug>/index.html
 *
 * Static site files (homepage, publish.html, 404.html, templates/) are
 * served from ./public via the ASSETS binding, same as before.
 */

const REPO_NAME = "dr3amy-pages"; // fixed convention — every user's storage repo must be named this

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Root, publish.html, templates/*, and any other real static asset
    const isStaticPath =
      parts.length === 0 ||
      url.pathname === "/publish.html" ||
      url.pathname === "/404.html" ||
      parts[0] === "templates";

    if (isStaticPath) {
      return env.ASSETS.fetch(request);
    }

    // Anything else with 2+ path segments is treated as a user page:
    // /<username>/<slug>/
    if (parts.length >= 2) {
      const [username, slug] = parts;
      const rawUrl = `https://raw.githubusercontent.com/${username}/${REPO_NAME}/main/p/${slug}/index.html`;

      const upstream = await fetch(rawUrl, {
        cf: { cacheTtl: 60, cacheEverything: true },
      });

      if (upstream.status === 200) {
        const html = await upstream.text();
        return new Response(html, {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "public, max-age=60",
          },
        });
      }
      // fall through to 404 below for any non-200 (missing repo, missing
      // page, private repo, wrong branch, etc.)
    }

    // 404 — serve the themed not-found page
    const notFound = await env.ASSETS.fetch(new URL("/404.html", url));
    return new Response(notFound.body, { status: 404, headers: notFound.headers });
  },
};
