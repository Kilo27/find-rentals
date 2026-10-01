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

// "304A 250 m, 14 min to UL": the nearest way to the campus, for a notification or a card.
export function describeTransit(transit) {
  const c = transit?.campuses?.[0];
  const o = c?.options?.[0];
  if (!o) return null;
  return `${o.label} ${o.distM} m away${o.mins ? `, ${o.mins} min to ${c.short}` : ` to ${c.short}`}`;
}

export function buildListingPayload(listing, config) {
  const price = listing.priceMonthly !== null ? `€${listing.priceMonthly.toLocaleString("en-IE")}/mo` : listing.priceText || "Price n/a";
  const flags = listing.flags ?? [];
  let dist = config.center.label;
  if (listing.distanceKm !== null && listing.distanceKm !== undefined) {
    dist = `${flags.includes("distance-approx") ? "~" : ""}${listing.distanceKm.toFixed(1)} km from ${config.center.label}`;
  } else if (flags.includes("distance-unverified")) dist = `distance unverified (${config.center.label} area)`;
  const extras = [];
  if (flags.includes("available-now")) extras.push("available now");
  else if (listing.availableFrom) extras.push(`from ${listing.availableFrom}`);
  if (flags.includes("ends-early")) extras.push(`ends ${listing.availableTo}`);
  if (flags.includes("short-term")) extras.push("short-term friendly");
  if (flags.includes("owner-occupied-unknown")) extras.push("check owner-occupied");
  const transit = flags.includes("transit-access") ? describeTransit(listing.transit) : null;
  const also = listing.alsoOn?.length ? `also on ${listing.alsoOn.map((a) => a.label).join(", ")}` : null;
  return {
    title: `${price} · ${listing.title}`.slice(0, 120),
    body: [dist, transit, listing.sourceLabel, listing.bedsText, ...extras, also].filter(Boolean).join(" · "),
    url: listing.url,
    tag: `listing-${listing.id}`,
  };
}
