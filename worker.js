/**
 * Custom Worker script for teracopia.com.
 *
 * Everything is served as a static asset (see [assets] in wrangler.toml)
 * EXCEPT the paths listed in `run_worker_first` below, which hit this
 * script first. That's currently /download/*, /secure/*, /webhook/*, and
 * /check-subscriber:
 *
 *   /download/ebook  - verifies a Stripe Checkout Session actually paid
 *                       for the book (or for coaching, which includes the
 *                       book free), then streams the real PDF back.
 *   /secure/*         - where the real, un-served-by-default ebook PDF
 *                       lives. Never linked publicly; only ever read
 *                       internally via env.ASSETS.fetch() from this
 *                       script. Any direct external request to it is
 *                       rejected below, since env.ASSETS.fetch() bypasses
 *                       this script entirely and would otherwise happily
 *                       serve it to anyone who found the path.
 *   /check-subscriber - read-only lookup the homepage signup form calls
 *                       before submitting, so it can tell someone who
 *                       already joined "Free Guide Signups" that they're
 *                       already on the list instead of implying a fresh
 *                       email is on its way.
 *
 * Requires Worker secrets (Cloudflare dashboard -> Workers & Pages ->
 * teracopia -> Settings -> Variables and Secrets, or `wrangler secret put
 * <NAME>`). Never commit any of these:
 *
 *   STRIPE_SECRET_KEY     - Stripe restricted/secret key with read access
 *                           to Checkout Sessions.
 *   STRIPE_WEBHOOK_SECRET - signing secret for the /webhook/stripe endpoint
 *                           below (from the Stripe Dashboard webhook you
 *                           create pointing at
 *                           https://teracopia.com/webhook/stripe, listening
 *                           for checkout.session.completed).
 *   MAILERLITE_API_KEY    - MailerLite API token. Used to upsert the buyer
 *                           as a subscriber with their personal download
 *                           link, and drop them into the "Ebook Buyers"
 *                           group, which is what actually triggers the
 *                           MailerLite automation that emails them (the
 *                           same pattern as the homepage free-guide
 *                           signup -> "Free Guide Signups" group flow).
 *
 *   /webhook/stripe   - Stripe webhook. On checkout.session.completed for
 *                       the ebook, verifies the event signature, then
 *                       upserts the buyer into MailerLite so its
 *                       automation can take over (confirmation email now,
 *                       review request in a few weeks, coaching pitch
 *                       later — all as steps in that one automation).
 */

const EBOOK_PRODUCT_ID = "prod_VGxRwAg1J1BU13"; // "Your Simple Guide to Lucid Dreaming"
const COACHING_PRODUCT_ID = "prod_VJxAFXxWfOLmGp"; // "Coaching Package: 6 Sessions" — coaching buyers get the book free, so /download/ebook also honors this product
const EBOOK_FILE_PATH = "/secure/your-simple-guide-to-lucid-dreaming.pdf";
const EBOOK_DOWNLOAD_NAME = "Your-Simple-Guide-to-Lucid-Dreaming.pdf";
const MAILERLITE_EBOOK_BUYERS_GROUP_ID = "199232136794867305"; // "Ebook Buyers" group
const MAILERLITE_FREE_GUIDE_GROUP_ID = "198878190159004793"; // "Free Guide Signups" group

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/download/ebook") {
      return handleEbookDownload(request, env);
    }

    if (url.pathname === "/webhook/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env, ctx);
    }

    if (url.pathname === "/check-subscriber" && request.method === "GET") {
      return handleCheckSubscriber(request, env);
    }

    if (url.pathname === "/api/dashboard" && request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: dashboardCorsHeaders() });
    }

    if (url.pathname === "/api/dashboard" && request.method === "GET") {
      return handleDashboard(request, env);
    }

    if ((url.pathname === "/dashboard" || url.pathname === "/dashboard/") && (request.method === "GET" || request.method === "POST")) {
      return handleDashboardPage(request, env);
    }

    if (url.pathname.startsWith("/secure/")) {
      // Only this script's own internal env.ASSETS.fetch() calls should
      // ever reach this file. Any request that gets here came in from
      // the outside, so refuse it.
      return new Response("Not found", { status: 404 });
    }

    // Anything else that matched run_worker_first but isn't handled
    // above: fall through to normal static asset serving.
    return env.ASSETS.fetch(request);
  },
};

async function handleEbookDownload(request, env) {
  if (!env.STRIPE_SECRET_KEY) {
    return new Response(
      "Downloads are temporarily unavailable. Please contact hello@teracopia.com and we'll get the book to you directly.",
      { status: 500 }
    );
  }

  const url = new URL(request.url);
  const sessionId = url.searchParams.get("session_id");

  if (!sessionId || !sessionId.startsWith("cs_")) {
    return new Response("Missing or invalid checkout session.", { status: 400 });
  }

  let session;
  try {
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    if (!stripeRes.ok) {
      return new Response("We couldn't verify that purchase. Contact hello@teracopia.com for help.", {
        status: 402,
      });
    }
    session = await stripeRes.json();
  } catch (err) {
    return new Response("We couldn't verify that purchase right now. Please try again shortly.", {
      status: 502,
    });
  }

  if (session.payment_status !== "paid") {
    return new Response("This purchase hasn't completed payment yet.", { status: 402 });
  }

  const purchasedEbook = (session.line_items?.data || []).some(
    (item) => item.price?.product === EBOOK_PRODUCT_ID
  );
  const purchasedCoaching = (session.line_items?.data || []).some(
    (item) => item.price?.product === COACHING_PRODUCT_ID
  );
  if (!purchasedEbook && !purchasedCoaching) {
    return new Response("This purchase doesn't include the ebook.", { status: 402 });
  }

  const fileUrl = new URL(EBOOK_FILE_PATH, request.url);
  const fileRes = await env.ASSETS.fetch(new Request(fileUrl, { headers: request.headers }));
  if (!fileRes.ok) {
    return new Response("The book file is temporarily unavailable. Contact hello@teracopia.com.", {
      status: 500,
    });
  }

  const headers = new Headers(fileRes.headers);
  headers.set("Content-Disposition", `attachment; filename="${EBOOK_DOWNLOAD_NAME}"`);
  headers.set("Cache-Control", "no-store");
  return new Response(fileRes.body, { status: 200, headers });
}

// GET /check-subscriber?email=... — used by the homepage signup form to
// show a different confirmation message to someone who has already joined
// the "Free Guide Signups" group, since re-submitting the form won't
// re-trigger that group's automation (MailerLite only fires "on joining a
// group" the first time). Read-only, no side effects. Always resolves to
// {"alreadySubscribed": false} on any lookup failure so a broken check
// never blocks a real signup — this is a cosmetic message choice, not a
// gate on the form.
async function handleCheckSubscriber(request, env) {
  const jsonResponse = (alreadySubscribed) =>
    new Response(JSON.stringify({ alreadySubscribed }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });

  const url = new URL(request.url);
  const email = url.searchParams.get("email");
  if (!email || !env.MAILERLITE_API_KEY) {
    return jsonResponse(false);
  }

  try {
    const res = await fetch(
      `https://connect.mailerlite.com/api/subscribers/${encodeURIComponent(email)}`,
      {
        headers: {
          Authorization: `Bearer ${env.MAILERLITE_API_KEY}`,
          Accept: "application/json",
        },
      }
    );

    if (!res.ok) {
      // 404 = never subscribed before; any other error, fail open.
      return jsonResponse(false);
    }

    const body = await res.json();
    const groups = body?.data?.groups || [];
    const alreadySubscribed = groups.some((g) => g.id === MAILERLITE_FREE_GUIDE_GROUP_ID);
    return jsonResponse(alreadySubscribed);
  } catch (err) {
    return jsonResponse(false);
  }
}

async function handleStripeWebhook(request, env, ctx) {
  if (!env.STRIPE_WEBHOOK_SECRET || !env.STRIPE_SECRET_KEY) {
    // Not configured yet — ack with 200 so Stripe doesn't retry forever,
    // but do nothing. (Configuring the secrets turns this on.)
    return new Response("Webhook not configured", { status: 200 });
  }

  const signatureHeader = request.headers.get("Stripe-Signature");
  const rawBody = await request.text();

  const valid = await verifyStripeSignature(rawBody, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    return new Response("Invalid signature", { status: 400 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (err) {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("ok", { status: 200 });
  }

  const sessionId = event.data?.object?.id;
  if (!sessionId) return new Response("ok", { status: 200 });

  // Re-fetch the session with line items expanded (the webhook payload
  // alone doesn't include them) — this reuses the exact same check as
  // the download endpoint, so "who gets an email" and "who can download"
  // never drift apart.
  let session;
  try {
    const stripeRes = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
      { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } }
    );
    if (!stripeRes.ok) return new Response("ok", { status: 200 });
    session = await stripeRes.json();
  } catch (err) {
    return new Response("ok", { status: 200 });
  }

  if (session.payment_status !== "paid") return new Response("ok", { status: 200 });

  const purchasedEbook = (session.line_items?.data || []).some(
    (item) => item.price?.product === EBOOK_PRODUCT_ID
  );
  if (!purchasedEbook) return new Response("ok", { status: 200 });

  const email = session.customer_details?.email;
  if (!email) return new Response("ok", { status: 200 });

  // Requires "Collect customer names" to be enabled on the Stripe Payment
  // Link, otherwise this is undefined and MailerLite just falls back to no
  // name (the automation's merge tag renders blank in that case).
  const name = session.customer_details?.name || "";

  const downloadUrl = new URL(`/download/ebook?session_id=${encodeURIComponent(sessionId)}`, request.url).toString();

  if (env.MAILERLITE_API_KEY) {
    ctx.waitUntil(addEbookBuyerToMailerLite(env, email, name, downloadUrl));
  }

  return new Response("ok", { status: 200 });
}

async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader) return false;

  const parts = {};
  for (const kv of sigHeader.split(",")) {
    const [k, v] = kv.split("=");
    parts[k] = v;
  }
  if (!parts.t || !parts.v1) return false;

  // Reject events older than 5 minutes to guard against replay.
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) {
    return false;
  }

  const signedPayload = `${parts.t}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const computed = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

  // Constant-time-ish compare.
  if (computed.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < computed.length; i++) diff |= computed.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

async function addEbookBuyerToMailerLite(env, toEmail, toName, downloadUrl) {
  // Upsert the subscriber with their personal download link in a custom
  // field, and drop them into the "Ebook Buyers" group. Joining that
  // group is what triggers the MailerLite automation which actually
  // sends the confirmation email (and, on the steps you add later, the
  // review request and the coaching pitch) — same mechanism as the
  // homepage signup form feeding "Free Guide Signups". "name" is the same
  // field key the homepage form uses (fields[name]), so {$name} works in
  // both automations.
  try {
    const fields = { ebook_download_link: downloadUrl };
    if (toName) fields.name = toName;

    await fetch("https://connect.mailerlite.com/api/subscribers", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MAILERLITE_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        email: toEmail,
        fields,
        groups: [MAILERLITE_EBOOK_BUYERS_GROUP_ID],
      }),
    });
  } catch (err) {
    // Best-effort: the download link is also shown on Stripe's own
    // success-page redirect, so a failed sync isn't a lost sale.
  }
}

// ============================================================================
// Accountability Dashboard API
// ============================================================================
//
// GET /api/dashboard — aggregates live metrics for Quinton's private
// accountability dashboard (not linked anywhere public). Requires the
// X-Dashboard-Token header to match env.DASHBOARD_TOKEN, so this never
// leaks business numbers to the public internet.
//
// Additional Worker secrets required (on top of the ones above):
//
//   DASHBOARD_TOKEN       - shared secret the dashboard page sends as the
//                           X-Dashboard-Token header. Generate any random
//                           string.
//   STRIPE_DASHBOARD_KEY  - read-only restricted Stripe key (separate from
//                           STRIPE_SECRET_KEY, which only needs Checkout
//                           Session read access for the download flow).
//   CALCOM_API_KEY        - Cal.com API key (Settings -> Developer ->
//                           API keys).
//   CF_API_TOKEN          - Cloudflare API token with Account Analytics:Read
//                           on this zone, used to pull Web Analytics via
//                           GraphQL.
//   CF_ZONE_TAG           - the teracopia.com zone ID (Cloudflare dashboard
//                           -> Overview -> API section, bottom right).
//
// MAILERLITE_API_KEY (already configured above) is reused for subscriber
// and campaign stats.

const EBOOK_PRICE_LOOKUP = new Set([EBOOK_PRODUCT_ID]);
const COACHING_PRICE_LOOKUP = new Set([COACHING_PRODUCT_ID]);

function dashboardCorsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "X-Dashboard-Token",
    "Access-Control-Max-Age": "86400",
  };
}

async function handleDashboard(request, env) {
  const token = request.headers.get("X-Dashboard-Token");
  if (!env.DASHBOARD_TOKEN || token !== env.DASHBOARD_TOKEN) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...dashboardCorsHeaders() },
    });
  }

  const [stripe, calcom, mailerlite, cloudflareAnalytics] = await Promise.all([
    fetchStripeDashboardData(env).catch((err) => ({ error: String(err) })),
    fetchCalcomData(env).catch((err) => ({ error: String(err) })),
    fetchMailerLiteData(env).catch((err) => ({ error: String(err) })),
    fetchCloudflareAnalytics(env).catch((err) => ({ error: String(err) })),
  ]);

  return new Response(
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      stripe,
      calcom,
      mailerlite,
      cloudflareAnalytics,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...dashboardCorsHeaders() },
    }
  );
}

function dayKey(date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay(); // 0 = Sunday
  d.setUTCDate(d.getUTCDate() - day);
  return dayKey(d);
}

async function fetchStripeDashboardData(env) {
  if (!env.STRIPE_DASHBOARD_KEY) return { error: "STRIPE_DASHBOARD_KEY not configured" };

  const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
  const sessions = [];
  let startingAfter = null;
  let pages = 0;

  // Stripe Checkout Sessions list, paginated, last 90 days, with line
  // items expanded so we can tell book vs. coaching apart.
  while (pages < 10) {
    const params = new URLSearchParams();
    params.set("limit", "100");
    params.set("created[gte]", String(ninetyDaysAgo));
    params.append("expand[]", "data.line_items");
    if (startingAfter) params.set("starting_after", startingAfter);

    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${env.STRIPE_DASHBOARD_KEY}` },
    });
    if (!res.ok) throw new Error(`Stripe list sessions failed: ${res.status}`);
    const page = await res.json();
    sessions.push(...(page.data || []));
    pages++;
    if (!page.has_more || !page.data?.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  const paid = sessions.filter((s) => s.payment_status === "paid");

  const dailyMap = new Map(); // date -> {book, coaching, revenueBook, revenueCoaching}
  const weeklyMap = new Map(); // weekStart -> {book, coaching, revenueBook, revenueCoaching}
  let totalBook = 0;
  let totalCoaching = 0;
  let revenueBook = 0;
  let revenueCoaching = 0;

  for (const session of paid) {
    const items = session.line_items?.data || [];
    const hasBook = items.some((i) => EBOOK_PRICE_LOOKUP.has(i.price?.product));
    const hasCoaching = items.some((i) => COACHING_PRICE_LOOKUP.has(i.price?.product));
    const created = new Date(session.created * 1000);
    const dKey = dayKey(created);
    const wKey = startOfWeek(created);
    const amount = (session.amount_total || 0) / 100;

    if (!dailyMap.has(dKey)) dailyMap.set(dKey, { date: dKey, book: 0, coaching: 0, revenueBook: 0, revenueCoaching: 0 });
    if (!weeklyMap.has(wKey)) weeklyMap.set(wKey, { weekStart: wKey, book: 0, coaching: 0, revenueBook: 0, revenueCoaching: 0 });

    if (hasCoaching) {
      // Coaching purchases include the book free — count the sale as
      // coaching, not double-counted as a separate book sale.
      dailyMap.get(dKey).coaching++;
      dailyMap.get(dKey).revenueCoaching += amount;
      weeklyMap.get(wKey).coaching++;
      weeklyMap.get(wKey).revenueCoaching += amount;
      totalCoaching++;
      revenueCoaching += amount;
    } else if (hasBook) {
      dailyMap.get(dKey).book++;
      dailyMap.get(dKey).revenueBook += amount;
      weeklyMap.get(wKey).book++;
      weeklyMap.get(wKey).revenueBook += amount;
      totalBook++;
      revenueBook += amount;
    }
  }

  const daily = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const weekly = [...weeklyMap.values()].sort((a, b) => a.weekStart.localeCompare(b.weekStart));

  return {
    windowDays: 90,
    totals: {
      book: totalBook,
      coaching: totalCoaching,
      all: totalBook + totalCoaching,
      revenueBook: Math.round(revenueBook * 100) / 100,
      revenueCoaching: Math.round(revenueCoaching * 100) / 100,
      revenueAll: Math.round((revenueBook + revenueCoaching) * 100) / 100,
    },
    daily,
    weekly,
  };
}

async function fetchCalcomData(env) {
  if (!env.CALCOM_API_KEY) return { error: "CALCOM_API_KEY not configured" };

  const res = await fetch(`https://api.cal.com/v1/bookings?apiKey=${encodeURIComponent(env.CALCOM_API_KEY)}`);
  if (!res.ok) throw new Error(`Cal.com bookings failed: ${res.status}`);
  const body = await res.json();
  const bookings = body.bookings || [];

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  let totalBooked = 0;
  let completed = 0;
  let upcoming = 0;
  let cancelled = 0;
  let bookedLast7Days = 0;
  let bookedLast30Days = 0;
  const dailyMap = new Map();

  for (const b of bookings) {
    const status = (b.status || "").toLowerCase();
    const start = new Date(b.startTime).getTime();
    const createdAt = new Date(b.createdAt || b.startTime).getTime();

    if (status === "cancelled" || status === "rejected") {
      cancelled++;
      continue;
    }
    totalBooked++;
    if (start < now) completed++;
    else upcoming++;

    if (createdAt >= sevenDaysAgo) bookedLast7Days++;
    if (createdAt >= thirtyDaysAgo) bookedLast30Days++;

    if (createdAt >= thirtyDaysAgo) {
      const dKey = dayKey(new Date(createdAt));
      dailyMap.set(dKey, (dailyMap.get(dKey) || 0) + 1);
    }
  }

  const daily = [...dailyMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { totalBooked, completed, upcoming, cancelled, bookedLast7Days, bookedLast30Days, daily };
}

async function fetchMailerLiteData(env) {
  if (!env.MAILERLITE_API_KEY) return { error: "MAILERLITE_API_KEY not configured" };

  const headers = {
    Authorization: `Bearer ${env.MAILERLITE_API_KEY}`,
    Accept: "application/json",
  };

  const now = Date.now();
  const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000;

  // Active subscriber count.
  const subsRes = await fetch("https://connect.mailerlite.com/api/subscribers?filter[status]=active&limit=1", {
    headers,
  });
  if (!subsRes.ok) throw new Error(`MailerLite subscribers failed: ${subsRes.status}`);
  const subsBody = await subsRes.json();
  const totalActiveSubscribers = subsBody.total ?? subsBody.meta?.total ?? null;

  // Recent subscribers (sorted newest first) to count new signups in the
  // last 7/30 days — capped at 500 most recent, which comfortably covers
  // a 30-day window at this list's current volume.
  let newLast7Days = 0;
  let newLast30Days = 0;
  const dailyMap = new Map();
  let cursor = null;
  let fetched = 0;

  while (fetched < 500) {
    const params = new URLSearchParams();
    params.set("filter[status]", "active");
    params.set("sort", "-created_at");
    params.set("limit", "100");
    if (cursor) params.set("cursor", cursor);

    const res = await fetch(`https://connect.mailerlite.com/api/subscribers?${params.toString()}`, { headers });
    if (!res.ok) break;
    const body = await res.json();
    const page = body.data || [];
    if (!page.length) break;

    let stop = false;
    for (const sub of page) {
      const createdAt = new Date(sub.created_at).getTime();
      if (createdAt < thirtyDaysAgo) {
        stop = true;
        break;
      }
      if (createdAt >= sevenDaysAgo) newLast7Days++;
      newLast30Days++;
      const dKey = dayKey(new Date(createdAt));
      dailyMap.set(dKey, (dailyMap.get(dKey) || 0) + 1);
    }

    fetched += page.length;
    cursor = body.meta?.next_cursor;
    if (stop || !cursor) break;
  }

  // Recent campaigns, for "emails sent" over the last 30 days.
  let campaignsSentLast30Days = 0;
  let emailsSentLast30Days = 0;
  try {
    const campRes = await fetch("https://connect.mailerlite.com/api/campaigns?filter[status]=sent&limit=50", {
      headers,
    });
    if (campRes.ok) {
      const campBody = await campRes.json();
      for (const c of campBody.data || []) {
        const sentAt = c.finished_at || c.scheduled_for || c.updated_at;
        if (sentAt && new Date(sentAt).getTime() >= thirtyDaysAgo) {
          campaignsSentLast30Days++;
          emailsSentLast30Days += c.stats?.sent || 0;
        }
      }
    }
  } catch (err) {
    // Non-fatal — campaign stats are a bonus metric.
  }

  const newSubscribersDaily = [...dailyMap.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    totalActiveSubscribers,
    newLast7Days,
    newLast30Days,
    newSubscribersDaily,
    campaignsSentLast30Days,
    emailsSentLast30Days,
  };
}

async function fetchCloudflareAnalytics(env) {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_TAG) {
    return { error: "CF_API_TOKEN / CF_ZONE_TAG not configured" };
  }

  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const until = new Date().toISOString().slice(0, 10);

  const query = `
    query {
      viewer {
        zones(filter: { zoneTag: "${env.CF_ZONE_TAG}" }) {
          httpRequests1dGroups(limit: 14, filter: { date_geq: "${since}", date_leq: "${until}" }, orderBy: [date_ASC]) {
            dimensions { date }
            sum { requests pageViews }
            uniq { uniques }
          }
        }
      }
    }
  `;

  const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`Cloudflare GraphQL failed: ${res.status}`);
  const body = await res.json();
  if (body.errors?.length) throw new Error(`Cloudflare GraphQL errors: ${JSON.stringify(body.errors)}`);

  const groups = body.data?.viewer?.zones?.[0]?.httpRequests1dGroups || [];
  const daily = groups.map((g) => ({
    date: g.dimensions.date,
    requests: g.sum.requests,
    pageViews: g.sum.pageViews,
    uniqueVisitors: g.uniq.uniques,
  }));

  const last7Days = daily.reduce(
    (acc, d) => ({
      requests: acc.requests + d.requests,
      pageViews: acc.pageViews + d.pageViews,
      uniqueVisitors: acc.uniqueVisitors + d.uniqueVisitors,
    }),
    { requests: 0, pageViews: 0, uniqueVisitors: 0 }
  );

  return {
    note: "Zone-level traffic from Cloudflare's edge logs (works without any JS beacon). Time-on-site isn't available here — that needs Cloudflare Web Analytics' RUM beacon enabled separately.",
    daily,
    last7Days,
  };
}


// ============================================================================
// Dashboard page password gate
// ============================================================================
//
// /dashboard itself (the static HTML) is only ever served after a password
// check here in the Worker, so the DASHBOARD_TOKEN embedded in that page's
// JS never reaches anyone who hasn't entered DASHBOARD_PASSWORD. A signed,
// HttpOnly cookie (DASHBOARD_SESSION_SECRET) keeps the owner logged in for
// 30 days without storing sessions anywhere.
//
// Additional Worker secrets required:
//   DASHBOARD_PASSWORD        - the password visitors must enter.
//   DASHBOARD_SESSION_SECRET  - random string used to sign the session
//                               cookie. Not the same as DASHBOARD_TOKEN.

const DASH_COOKIE = "dash_auth";
const DASH_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

async function signDashboardSession(env, expiresAt) {
  const payload = String(expiresAt);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.DASHBOARD_SESSION_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  const sig = [...new Uint8Array(sigBuffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${payload}.${sig}`;
}

async function verifyDashboardSession(env, token) {
  if (!token || !env.DASHBOARD_SESSION_SECRET) return false;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const expiresAt = Number(payload);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;
  const expected = await signDashboardSession(env, expiresAt);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}

function readCookie(request, name) {
  const header = request.headers.get("Cookie") || "";
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

function dashboardLoginPage({ error } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>Teracopia Pulse</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    font-family: system-ui, -apple-system, sans-serif; background:#eef1f7; color:#16192b; }
  @media (prefers-color-scheme: dark) { body { background:#0e1120; color:#eef0fb; } }
  form { background:#fff; border:1px solid #e6e8f1; border-radius:14px; padding:28px 26px;
    box-shadow:0 8px 24px -12px rgba(22,25,43,0.15); width:min(90vw, 320px); }
  @media (prefers-color-scheme: dark) { form { background:#171b30; border-color:#272c4d; } }
  h1 { font-size:17px; margin:0 0 4px; }
  p.sub { font-size:12.5px; color:#7a7f99; margin:0 0 18px; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:8px; border:1px solid #e6e8f1;
    font-size:14px; margin-bottom:12px; background:transparent; color:inherit; }
  @media (prefers-color-scheme: dark) { input { border-color:#272c4d; } }
  button { width:100%; padding:10px; border-radius:8px; border:none; background:#3b6ef6; color:#fff;
    font-size:14px; font-weight:600; cursor:pointer; }
  .error { color:#e5484d; font-size:12.5px; margin:-4px 0 12px; }
</style></head>
<body>
  <form method="POST" action="/dashboard">
    <h1>Teracopia Pulse</h1>
    <p class="sub">Private dashboard — enter password to continue</p>
    ${error ? '<div class="error">Incorrect password.</div>' : ""}
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Unlock</button>
  </form>
</body></html>`;
}

async function handleDashboardPage(request, env) {
  if (!env.DASHBOARD_PASSWORD || !env.DASHBOARD_SESSION_SECRET) {
    return new Response("Dashboard not configured yet.", { status: 500 });
  }

  if (request.method === "POST") {
    const form = await request.formData();
    const password = String(form.get("password") || "");
    if (password === env.DASHBOARD_PASSWORD) {
      const expiresAt = Date.now() + DASH_SESSION_MS;
      const token = await signDashboardSession(env, expiresAt);
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/dashboard",
          "Set-Cookie": `${DASH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${DASH_SESSION_MS / 1000}; Path=/dashboard; HttpOnly; Secure; SameSite=Lax`,
        },
      });
    }
    return new Response(dashboardLoginPage({ error: true }), {
      status: 401,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  const authed = await verifyDashboardSession(env, readCookie(request, DASH_COOKIE));
  if (!authed) {
    return new Response(dashboardLoginPage(), { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }

  const assetUrl = new URL("/dashboard/index.html", request.url);
  const fileRes = await env.ASSETS.fetch(new Request(assetUrl, { headers: request.headers }));
  const headers = new Headers(fileRes.headers);
  headers.set("Cache-Control", "no-store");
  return new Response(fileRes.body, { status: fileRes.status, headers });
}