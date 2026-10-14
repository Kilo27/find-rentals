import { ADAPTERS } from "./sources/index.js";
import { ADMIN_OWNER } from "./push.js";
import { activeSources } from "./regions.js";

// Long enough to ride out a redeploy (the agent reconnects within a minute) or a Wi-Fi change, short enough that the
// admin hears while there is still time to wake the laptop.
export const DEFAULT_ALERT_AFTER_MS = 5 * 60_000;
const CHECK_EVERY_MS = 60_000;

// LAPTOP_ALERT_AFTER_MINUTES: how long the agent must be gone before the admin is told. 0 means as soon as it is noticed.
export function alertAfterFromEnv(env = process.env) {
  const raw = env.LAPTOP_ALERT_AFTER_MINUTES;
  const minutes = raw === undefined || String(raw).trim() === "" ? NaN : Number(raw);
  return Number.isFinite(minutes) && minutes >= 0 ? minutes * 60_000 : DEFAULT_ALERT_AFTER_MS;
}

// Tells the admin's devices when the laptop agent has been gone for a while, and again when it is back. It looks at the
// agent itself rather than at scans, so the note arrives when the laptop goes away, not at the next 30-minute scan. How the
// scanner is doing is for whoever runs it, so nobody else is told. The state lives in the store, so a restart neither
// forgets an outage nor repeats its note, and the clock only runs while the server is up to see the agent missing.
export function createLaptopWatch({ store, pusher, proxy, alertAfterMs = DEFAULT_ALERT_AFTER_MS, checkEveryMs = CHECK_EVERY_MS, now = () => new Date(), log = console }) {
  let timer = null;
  let busy = false;

  const toAdmin = (payload) => pusher.sendToOwner(ADMIN_OWNER, payload);

  // The sources that need the agent, by name: those of the regions somebody is watching in. Empty when the agent isn't in use or none of them is switched on.
  const routedLabels = () =>
    proxy.kind === "laptop" ? activeSources(store).filter((id) => proxy.sources.has(id)).map((id) => ADAPTERS[id]?.label ?? id) : [];

  async function check() {
    const labels = routedLabels();
    const lap = (store.data.laptop ??= {});
    const names = labels.join(" and ");
    const plural = labels.length > 1;

    if (labels.length === 0 || proxy.online()) {
      const wasNotified = lap.offlineNotified === true;
      if (!lap.offlineSince && !wasNotified) return;
      lap.offlineSince = null;
      lap.offlineNotified = false;
      store.save();
      if (wasNotified && labels.length) {
        await toAdmin({ title: "Laptop agent is back", body: `${names} ${plural ? "are" : "is"} being checked again.`, url: "/", tag: "laptop" });
      }
      return;
    }

    const t = now();
    if (!lap.offlineSince) {
      lap.offlineSince = t.toISOString();
      store.save();
    }
    if (lap.offlineNotified || t.getTime() - Date.parse(lap.offlineSince) < alertAfterMs) return;
    lap.offlineNotified = true;
    store.save();
    await toAdmin({
      title: "Laptop agent offline",
      body: `${names} ${plural ? "aren't" : "isn't"} being checked. Wake the laptop or start npm run agent.`,
      url: "/",
      tag: "laptop",
    });
  }

  // Never overlaps itself and never throws, so a failed push can't take the server down.
  async function tick() {
    if (busy) return;
    busy = true;
    try {
      await check();
    } catch (err) {
      log.warn?.(`[agent] laptop watch failed: ${err.message}`);
    } finally {
      busy = false;
    }
  }

  return {
    check: tick,
    start() {
      if (timer) return;
      timer = setInterval(tick, checkEveryMs);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
