/**
 * Dr3amy Pages — OAuth backend (Worker)
 * ------------------------------------------------------------
 * This Worker does ONE job: GitHub OAuth. It is NOT what serves
 * dr3amy.creepers.pro — that's GitHub Pages, serving straight from the
 * dr3amy-pages repo. This Worker lives on its own workers.dev URL and
 * exists purely so the client secret never has to touch the browser.
 *
 * Flow:
 *   dashboard.html (on GitHub Pages)
 *     → links to   https://<this-worker>.workers.dev/auth/github
 *     → Worker redirects to GitHub's real authorize screen
 *     → GitHub redirects back to  .../auth/callback  (still this Worker)
 *     → Worker exchanges the code for a token server-side (secret stays here)
 *     → Worker redirects to  https://dr3amy.creepers.pro/dashboard.html?gh_token=...&gh_login=...
 *     → dashboard.html (back on GitHub Pages) picks up the token and signs in
 *
 * Required Worker secrets:
 *   GITHUB_CLIENT_ID
 *   GITHUB_CLIENT_SECRET
 *
 * The GitHub OAuth App's "Authorization callback URL" must be set to
 * this Worker's own URL + /auth/callback — e.g.
 *   https://dr3amy-pages.<your-subdomain>.workers.dev/auth/callback
 * NOT dr3amy.creepers.pro, since this Worker doesn't serve that domain.
 */

// Where to send people back to once sign-in is done — the real site, on GitHub Pages.
const SITE_URL = "https://dr3amy.creepers.pro";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Kick off GitHub's authorize screen ──
    if (url.pathname === "/auth/github") {
      const redirectUri = `${url.origin}/auth/callback`;
      const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
      authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("scope", "public_repo");
      authorizeUrl.searchParams.set("allow_signup", "true");
      return Response.redirect(authorizeUrl.toString(), 302);
    }

    // ── GitHub redirects back here with ?code= ──
    if (url.pathname === "/auth/callback") {
      const code = url.searchParams.get("code");
      if (!code) {
        return Response.redirect(`${SITE_URL}/dashboard.html?auth_error=missing_code`, 302);
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
            `${SITE_URL}/dashboard.html?auth_error=${encodeURIComponent(tokenData.error_description || tokenData.error || "token_exchange_failed")}`,
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

        const redirectTo = new URL(`${SITE_URL}/dashboard.html`);
        redirectTo.searchParams.set("gh_token", tokenData.access_token);
        redirectTo.searchParams.set("gh_login", user.login);
        return Response.redirect(redirectTo.toString(), 302);
      } catch (e) {
        return Response.redirect(
          `${SITE_URL}/dashboard.html?auth_error=${encodeURIComponent(e.message)}`,
          302
        );
      }
    }

    // Anything else on this Worker isn't used for anything — it's not the site.
    return new Response("Dr3amy Pages auth backend. The site itself is at " + SITE_URL, { status: 200 });
  },
};
