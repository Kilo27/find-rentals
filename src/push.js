import webpushLib from "web-push";

// Every push subscription belongs to one account. Subscriptions saved before accounts existed have no owner and
// belong to the admin.
export const ADMIN_OWNER = "@admin";
export const ownerOf = (sub) => sub.owner ?? ADMIN_OWNER;

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

  async function send(targets, payload) {
    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    const dead = new Set();

    await Promise.all(
      targets.map(async (sub) => {
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

  const sendToAll = (payload) => send(subs(), payload);
  const sendToOwner = (owner, payload) => send(subs().filter((s) => ownerOf(s) === owner), payload);

  function addSubscription(sub, userAgent = "", owner = ADMIN_OWNER) {
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
      owner,
    };
    store.data.subscriptions = [...subs().filter((s) => s.endpoint !== entry.endpoint), entry];
    store.save();
  }

  // With an owner, only that account's own device can be removed.
  function removeSubscription(endpoint, owner) {
    store.data.subscriptions = subs().filter((s) => s.endpoint !== endpoint || (owner !== undefined && ownerOf(s) !== owner));
    store.save();
  }

  function removeOwner(owner) {
    store.data.subscriptions = subs().filter((s) => ownerOf(s) !== owner);
    store.save();
  }

  const subscriptionsOf = (owner) => subs().filter((s) => ownerOf(s) === owner);

  return {
    publicKey,
    sendToAll,
    sendToOwner,
    addSubscription,
    removeSubscription,
    removeOwner,
    subscriptionsOf,
    count: (owner) => (owner === undefined ? subs().length : subscriptionsOf(owner).length),
  };
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
  const also = listing.alsoOn?.length ? `also on ${listing.alsoOn.map((a) => a.label).join(", ")}` : null;
  return {
    title: `${price} · ${listing.title}`.slice(0, 120),
    body: [dist, listing.sourceLabel, listing.bedsText, ...extras, also].filter(Boolean).join(" · "),
    url: listing.url,
    tag: `listing-${listing.id}`,
  };
}
