/**
 * Dr3amy Pages — Worker entrypoint
 * ------------------------------------------------------------
 * Two jobs:
 *
 * 1. GitHub OAuth — /auth/github and /auth/callback let people sign in
 *    with a real "Sign in with GitHub" button instead of pasting a
 *    personal access token. The client secret lives only here, as a
 *    Worker secret, never in the browser.
 *
 * 2. Page routing — dr3amy.creepers.pro/<username>/<slug>/ fetches that
 *    user's file straight from raw.githubusercontent.com. GitHub is
 *    storage only; nobody needs GitHub Pages turned on.
 *
 * Static files (index.html, dashboard.html, 404.html, templates/) are
 * served automatically by the Assets platform and never reach this
 * fetch handler unless the path doesn't match a real file.
 *
 * Required Worker secrets:
 *   GITHUB_CLIENT_ID
 *   GITHUB_CLIENT_SECRET
 */

const REPO_NAME = "dr3amy-pages";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // ── OAuth: kick off the GitHub authorize redirect ──
    if (url.pathname === "/auth/github") {
      const redirectUri = `${url.origin}/auth/callback`;
      const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", "public_repo");
      authorizeUrl.searchParams.set("allow_signup", "true");
      return Response.redirect(authorizeUrl.toString(), 302);
    }

    // ── OAuth: GitHub redirects back here with a ?code= ──
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return Response.redirect(`${url.origin}/dashboard.html?auth_error=missing_code`, 302);
      }

      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${url.origin}/auth/callback`,
          }),
        });
        const tokenData = await tokenRes.json();

        if (tokenData.error || !tokenData.access_token) {
          return Response.redirect(
            `${url.origin}/dashboard.html?auth_error=${encodeURIComponent(tokenData.error_description || tokenData.error || "token_exchange_failed")}`,
            302
          );
        }

        const userRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": "dr3amy-pages-worker",
          },
        });
        const user = await userRes.json();

        const redirectTo = new URL(`${url.origin}/dashboard.html`);
        redirectTo.searchParams.set("gh_token", tokenData.access_token);
        redirectTo.searchParams.set("gh_login", user.login);
        return Response.redirect(redirectTo.toString(), 302);
      } catch (e) {
        return Response.redirect(
          `${url.origin}/dashboard.html?auth_error=${encodeURIComponent(e.message)}`,
          302
        );
      }
    }

    // ── User page proxy: /<username>/<slug>/ ──
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
    }

    // ── 404 fallback ──
    const notFound = await env.ASSETS.fetch(new URL("/404.html", url));
    return new Response(notFound.body, { status: 404, headers: notFound.headers });
  },
};
