// app/api/fireworks/whoami/route.js
//
// Browser-hittable endpoint that asks Fireworks "who am I?" using the
// configured FIREWORKS_API_KEY. Returns the list of accounts the key
// has access to — so the user can see their real account slug without
// hunting through the Fireworks dashboard.
//
// Usage (any browser, phone included):
//
//   https://<your-app>.vercel.app/api/fireworks/whoami?key=<CRON_SECRET>
//
// Returns JSON with:
//   - Every account name/slug the key can see
//   - A diagnosis telling you whether your configured
//     FIREWORKS_ACCOUNT_ID matches one of them
//   - The exact string to paste into Vercel if it's wrong

export const maxDuration = 30;
export const runtime     = "nodejs";

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET(req) {
  const url = new URL(req.url);
  const key = url.searchParams.get("key");

  const authHeader = req.headers.get("authorization");
  const authByHeader = authHeader === `Bearer ${process.env.CRON_SECRET}`;
  const authByQuery  = key && key === process.env.CRON_SECRET;

  if (!authByHeader && !authByQuery) {
    return json({ ok: false, error: "Unauthorized. Append ?key=<CRON_SECRET> to the URL." }, 401);
  }

  const apiKey = process.env.FIREWORKS_API_KEY;
  if (!apiKey) {
    return json({ ok: false, error: "FIREWORKS_API_KEY is not set on Vercel." }, 500);
  }

  const configuredAccountId = process.env.FIREWORKS_ACCOUNT_ID || null;

  try {
    const res = await fetch("https://api.fireworks.ai/v1/accounts?pageSize=50", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    const raw = await res.text();

    if (!res.ok) {
      return json({
        ok:              false,
        status:          res.status,
        bodyPreview:     raw.slice(0, 400),
        configuredAccountId,
        hint:
          res.status === 401 ? "Your FIREWORKS_API_KEY is invalid, revoked, or scoped to no accounts." :
          res.status === 403 ? "Your FIREWORKS_API_KEY lacks permission to list accounts." :
          `Fireworks returned ${res.status}. Check the body preview above.`,
      }, 502);
    }

    let data;
    try { data = JSON.parse(raw); } catch {
      return json({ ok: false, error: "Fireworks returned non-JSON", bodyPreview: raw.slice(0, 400) }, 502);
    }

    const accounts = (data.accounts || []).map(a => ({
      // The API returns `name: "accounts/<slug>"` — split to give them the slug.
      id:          (a.name || "").replace(/^accounts\//, ""),
      name:        a.name,
      displayName: a.displayName || null,
      email:       a.email || null,
      accountType: a.accountType || null,
      state:       a.state || null,
    }));

    if (accounts.length === 0) {
      return json({
        ok:                  false,
        configuredAccountId,
        accountsAccessible:  [],
        hint: "Your API key sees zero accounts. It may be scoped to a team you haven't been added to, or it may be revoked.",
      });
    }

    const configuredMatches = configuredAccountId
      ? accounts.some(a => a.id === configuredAccountId)
      : false;

    const recommendedId = accounts[0].id;

    return json({
      ok:                  true,
      configuredAccountId,
      configuredMatches,
      accountsAccessible:  accounts,
      recommendation: configuredMatches
        ? `Your FIREWORKS_ACCOUNT_ID="${configuredAccountId}" is correct.`
        : `Your FIREWORKS_ACCOUNT_ID should be: ${recommendedId}. Set this on Vercel Settings → Environment Variables, then redeploy.`,
    });
  } catch (err) {
    return json({
      ok:    false,
      error: String(err.message || err),
    }, 500);
  }
}
