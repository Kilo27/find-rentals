import { fetchSection } from "./daft.js";
import { evaluateListing } from "./filter.js";
import { buildListingPayload } from "./push.js";

const MAX_INDIVIDUAL_PUSHES = 5;
const MAX_STORED_MATCHES = 200;
const SEEN_TTL_MS = 365 * 24 * 3600 * 1000;

export function createScanner({ store, pusher, fetchImpl = fetch, now = () => new Date() }) {
  let inflight = null;

  function run() {
    if (!inflight) inflight = doScan().finally(() => (inflight = null));
    return inflight;
  }

  async function doScan() {
    const t0 = now();
    const nowIso = t0.toISOString();
    const config = store.data.config;
    const results = [];
    const candidates = new Map();

    for (const section of config.sections) {
      try {
        const r = await fetchSection(config, section, { fetchImpl });
        results.push({ section, ok: true, total: r.total, fetched: r.listings.length, degraded: r.degraded });
        if (r.rawSample) store.data.debug[section] = { at: nowIso, sample: r.rawSample };
        for (const l of r.listings) if (!candidates.has(l.id)) candidates.set(l.id, l);
      } catch (err) {
        results.push({ section, ok: false, error: err.message, status: err.status ?? null, body: err.body ?? "" });
      }
    }

    const okSections = new Set(results.filter((r) => r.ok).map((r) => r.section));
    const failedSections = new Set(results.filter((r) => !r.ok).map((r) => r.section));

    if (okSections.size === 0) {
      const firstError = results[0]?.error ?? "No sections enabled";
      store.data.failureCount += 1;
      store.data.lastRun = { at: nowIso, durationMs: now() - t0, ok: false, error: firstError, sections: results };
      store.save();
      const n = store.data.failureCount;
      if (n === 3 || n % 48 === 0) {
        await pusher.sendToAll({
          title: "Rental bot can't reach Daft",
          body: `${n} scans failed in a row: ${firstError}`,
          url: "/",
          tag: "scan-failure",
        });
      }
      return store.data.lastRun;
    }

    const recovered = store.data.failureCount >= 3;
    store.data.failureCount = 0;

    const matches = [];
    let rejected = 0;
    for (const listing of candidates.values()) {
      const ev = evaluateListing(listing, config);
      if (!ev.ok) {
        rejected++;
        continue;
      }
      matches.push({ ...listing, distanceKm: ev.distanceKm, flags: ev.flags });
    }
    matches.sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));

    const seen = store.data.seen;
    const fresh = matches.filter((m) => !seen[m.id]);
    let notified = 0;
    let mode = "normal";

    if (!store.data.baselineDone) {
      mode = "baseline";
      await pusher.sendToAll({
        title: matches.length ? `Watching started: ${matches.length} current matches` : "Watching started",
        body: matches.length
          ? `Within ${config.radiusKm} km of ${config.center.label}. You'll be alerted to new ones.`
          : `Nothing matches yet within ${config.radiusKm} km of ${config.center.label}. You'll be alerted when something does.`,
        url: "/",
        tag: "baseline",
      });
      for (const m of fresh) seen[m.id] = { firstSeenAt: nowIso };
      store.data.baselineDone = true;
    } else if (fresh.length) {
      const subscribed = pusher.count() > 0;
      const individual = fresh.slice(0, MAX_INDIVIDUAL_PUSHES);
      const delivered = new Set();
      for (const m of individual) {
        const r = await pusher.sendToAll(buildListingPayload(m, config));
        if (r.sent > 0 || !subscribed) delivered.add(m.id);
        if (r.sent > 0) notified++;
      }
      const overflow = fresh.slice(MAX_INDIVIDUAL_PUSHES);
      if (overflow.length) {
        const r = await pusher.sendToAll({
          title: `${overflow.length} more new listings`,
          body: `Open the app to see everything new within ${config.radiusKm} km of ${config.center.label}.`,
          url: "/",
          tag: "digest",
        });
        if (r.sent > 0 || !subscribed) for (const m of overflow) delivered.add(m.id);
      }
      for (const m of fresh) if (delivered.has(m.id)) seen[m.id] = { firstSeenAt: nowIso };
    }

    if (recovered) {
      await pusher.sendToAll({ title: "Rental bot is back", body: "Daft scans are working again.", url: "/", tag: "scan-failure" });
    }

    const cutoff = t0.getTime() - SEEN_TTL_MS;
    for (const [id, v] of Object.entries(seen)) {
      if (Date.parse(v.firstSeenAt) < cutoff) delete seen[id];
    }

    const kept = store.data.matches.filter((m) => failedSections.has(m.section) && !matches.some((x) => x.id === m.id));
    store.data.matches = [...matches.map((m) => ({ ...m, firstSeenAt: seen[m.id]?.firstSeenAt ?? null })), ...kept]
      .slice(0, MAX_STORED_MATCHES)
      .map(({ text, ...rest }) => rest);

    store.data.lastRun = {
      at: nowIso,
      durationMs: now() - t0,
      ok: true,
      mode,
      sections: results,
      candidates: candidates.size,
      rejected,
      matches: matches.length,
      newCount: fresh.length,
      notified,
    };
    store.save();
    return store.data.lastRun;
  }

  return { run, isRunning: () => inflight !== null };
}
