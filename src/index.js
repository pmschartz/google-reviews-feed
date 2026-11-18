// Cloudflare Worker: pulls the newest Google reviews for a Business Profile
// location and serves them as JSON for OptiSigns OptiSync to poll.
//
// GET /reviews.json  -> cached JSON (fast, served from KV)
// GET /refresh        -> forces an immediate refresh from Google, then returns the JSON
// (scheduled)         -> cron trigger refreshes the cache automatically

const STARS = ["", "★", "★★", "★★★", "★★★★", "★★★★★"];

const STAR_RATING_TO_NUMBER = {
  STAR_RATING_UNSPECIFIED: 0,
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

async function getAccessToken(env) {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });

  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function fetchReviews(env) {
  const accessToken = await getAccessToken(env);
  const url = `https://mybusiness.googleapis.com/v4/accounts/${env.GOOGLE_ACCOUNT_ID}/locations/${env.GOOGLE_LOCATION_ID}/reviews?pageSize=50`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    throw new Error(`Reviews fetch failed: ${res.status} ${await res.text()}`);
  }

  return res.json();
}

function truncate(text, max) {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max).replace(/\s+\S*$/, "");
  return `${cut}...`;
}

function monthYear(isoDate) {
  const d = new Date(isoDate);
  return d.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function buildPayload(raw, env) {
  const count = Math.max(Number(env.REVIEW_COUNT) || 5, 1);
  const maxChars = Math.max(Number(env.MAX_REVIEW_CHARS) || 300, 50);

  const reviews = (raw.reviews || [])
    .filter((r) => r.comment && r.comment.trim())
    .sort((a, b) => new Date(b.createTime) - new Date(a.createTime))
    .slice(0, count)
    .map((r) => {
      const stars = STAR_RATING_TO_NUMBER[r.starRating] ?? 0;
      const name = r.reviewer?.displayName || "Anonymous";
      const text = truncate(r.comment || "", maxChars);
      return {
        name,
        stars,
        stars_display: STARS[stars],
        date: monthYear(r.createTime),
        text,
        text_with_name: `"${text}" - ${name}`,
        source: "Google",
      };
    });

  return {
    business: env.BUSINESS_NAME || "",
    rating: raw.averageRating != null ? Math.round(raw.averageRating * 10) / 10 : null,
    review_count: raw.totalReviewCount ?? reviews.length,
    updated_at: new Date().toISOString(),
    reviews,
  };
}

async function refreshCache(env) {
  const raw = await fetchReviews(env);
  const payload = buildPayload(raw, env);
  await env.REVIEWS_KV.put("latest", JSON.stringify(payload));
  return payload;
}

async function isAuthorized(request, secret) {
  const header = request.headers.get("Authorization") || "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(secret)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/refresh") {
      // Disabled unless REFRESH_SECRET is set; requires "Authorization: Bearer <secret>".
      if (!env.REFRESH_SECRET) return new Response("Not found", { status: 404 });
      if (!(await isAuthorized(request, env.REFRESH_SECRET))) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: CORS_HEADERS,
        });
      }
      try {
        const payload = await refreshCache(env);
        return new Response(JSON.stringify(payload, null, 2), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: CORS_HEADERS,
        });
      }
    }

    if (url.pathname === "/reviews.json" || url.pathname === "/") {
      const cached = await env.REVIEWS_KV.get("latest");
      if (cached) {
        return new Response(cached, { headers: CORS_HEADERS });
      }
      // Nothing cached yet (first run) — fetch synchronously once.
      try {
        const payload = await refreshCache(env);
        return new Response(JSON.stringify(payload, null, 2), { headers: CORS_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: CORS_HEADERS,
        });
      }
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshCache(env).then(
        (p) => console.log(`Refreshed ${p.reviews.length} reviews, rating ${p.rating}`),
        (err) => console.error(`Scheduled refresh failed: ${err.message}`)
      )
    );
  },
};
