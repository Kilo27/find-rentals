import webpushLib from "web-push";

export function resolveSubject(env = process.env) {
  if (env.VAPID_SUBJECT) return env.VAPID_SUBJECT;
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${env.RAILWAY_PUBLIC_DOMAIN}`;
  return "mailto:admin@find-rentals.example.com";
}

export function createPusher({ store, webpush = webpushLib, env = process.env }) {
  const subject = resolveSubject(env);

  if (env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY) {
    store.data.vapid = { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  } else if (!store.data.vapid) {
    store.data.vapid = webpush.generateVAPIDKeys();
    store.save();
  }
  const { publicKey, privateKey } = store.data.vapid;

  const subs = () => store.data.subscriptions;

  async function sendToAll(payload) {
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    const dead = new Set();

    await Promise.all(
      subs().map(async (sub) => {
        try {
          await webpush.sendNotification(sub, body, {
            TTL: 60 * 60 * 24,
            urgency: "high",
            vapidDetails: { subject, publicKey, privateKey },
          });
          sent++;
          sub.lastError = null;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            dead.add(sub.endpoint);
          } else {
            failed++;
            sub.lastError = `${err.statusCode ?? ""} ${err.body ?? err.message}`.trim().slice(0, 200);
          }
        }
      }),
    );

    if (dead.size) store.data.subscriptions = subs().filter((s) => !dead.has(s.endpoint));
    if (dead.size || failed) store.save();
    return { sent, failed, removed: dead.size };
  }

  function addSubscription(sub, userAgent = "") {
    if (!sub || typeof sub.endpoint !== "string" || !sub.keys?.p256dh || !sub.keys?.auth) {
      throw new Error("Invalid push subscription");
    }
    if (!/^https:\/\//.test(sub.endpoint)) throw new Error("Push endpoint must be https");
    const entry = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      userAgent: String(userAgent).slice(0, 200),
      addedAt: new Date().toISOString(),
      lastError: null,
    };
    store.data.subscriptions = [...subs().filter((s) => s.endpoint !== entry.endpoint), entry];
    store.save();
  }

  function removeSubscription(endpoint) {
    store.data.subscriptions = subs().filter((s) => s.endpoint !== endpoint);
    store.save();
  }

  return { publicKey, sendToAll, addSubscription, removeSubscription, count: () => subs().length };
}

export function buildListingPayload(listing, config) {
  const price = listing.priceMonthly !== null ? `€${listing.priceMonthly.toLocaleString("en-IE")}/mo` : listing.priceText || "Price n/a";
  const dist = listing.distanceKm !== null ? `${listing.distanceKm.toFixed(1)} km from ${config.center.label}` : config.center.label;
  const extras = [];
  if (listing.flags?.includes("short-term")) extras.push("short-term friendly");
  if (listing.flags?.includes("owner-occupied-unknown")) extras.push("check owner-occupied");
  return {
    title: `${price} · ${listing.title}`.slice(0, 120),
    body: [dist, listing.bedsText, ...extras].filter(Boolean).join(" · "),
    url: listing.url,
    tag: `listing-${listing.id}`,
  };
}
