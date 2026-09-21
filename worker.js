/**
 * Custom Worker script for teracopia.com.
 *
 * Everything is served as a static asset (see [assets] in wrangler.toml)
 * EXCEPT the paths listed in `run_worker_first` below, which hit this
 * script first. That's currently just /download/* and /secure/*:
 *
 *   /download/ebook  - verifies a Stripe Checkout Session actually paid
 *                       for the book, then streams the real PDF back.
 *   /secure/*         - where the real, un-served-by-default ebook PDF
 *                       lives. Never linked publicly; only ever read
 *                       internally via env.ASSETS.fetch() from this
 *                       script. Any direct external request to it is
 *                       rejected below, since env.ASSETS.fetch() bypasses
 *                       this script entirely and would otherwise happily
 *                       serve it to anyone who found the path.
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
 *   RESEND_API_KEY        - Resend API key, used to email buyers their
 *                           download link right after purchase.
 *
 *   /webhook/stripe   - Stripe webhook. On checkout.session.completed for
 *                       the ebook, verifies the event signature, then
 *                       emails the buyer their download link via Resend.
 */

const EBOOK_PRODUCT_ID = "prod_VGxRwAg1J1BU13"; // "Your Simple Guide to Lucid Dreaming"
const EBOOK_FILE_PATH = "/secure/your-simple-guide-to-lucid-dreaming.pdf";
const EBOOK_DOWNLOAD_NAME = "Your-Simple-Guide-to-Lucid-Dreaming.pdf";
const CONFIRMATION_FROM_EMAIL = "Teracopia <hello@teracopia.com>";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/download/ebook") {
      return handleEbookDownload(request, env);
    }

    if (url.pathname === "/webhook/stripe" && request.method === "POST") {
      return handleStripeWebhook(request, env, ctx);
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
  if (!purchasedEbook) {
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

  const downloadUrl = new URL(`/download/ebook?session_id=${encodeURIComponent(sessionId)}`, request.url).toString();

  if (env.RESEND_API_KEY) {
    ctx.waitUntil(sendConfirmationEmail(env, email, downloadUrl));
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

async function sendConfirmationEmail(env, toEmail, downloadUrl) {
  const html = `
    <div style="font-family: Georgia, 'Times New Roman', serif; max-width: 560px; margin: 0 auto; color: #1a1a2e;">
      <h1 style="font-size: 22px;">Your book is ready</h1>
      <p>Thanks for picking up <em>Your Simple Guide to Lucid Dreaming</em>. Here's your download link:</p>
      <p style="margin: 28px 0;">
        <a href="${downloadUrl}" style="background:#102EA0;color:#fff;padding:14px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Download the ebook</a>
      </p>
      <p>If that button doesn't work, copy and paste this link into your browser:<br>
      <a href="${downloadUrl}">${downloadUrl}</a></p>
      <p>Hold onto this email — this link is tied to your purchase and works any time you need it again.</p>
      <p>Sweet dreams,<br>Quinton</p>
    </div>
  `;

  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: CONFIRMATION_FROM_EMAIL,
        to: [toEmail],
        subject: "Your Simple Guide to Lucid Dreaming — download link inside",
        html,
      }),
    });
  } catch (err) {
    // Best-effort: the download link is also shown on Stripe's own
    // success-page redirect, so a failed email isn't a lost sale.
  }
}
