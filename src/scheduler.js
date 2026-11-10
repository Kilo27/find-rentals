// Each region is collected on its own timer, at the interval set for that region, so a region that is busy or slow
// doesn't hold up the others and the admin can look at a region more or less often than another. Regions nobody is
// watching in are left alone (the scanner skips them), but their timers keep running so that they start at once when
// someone chooses a campus there.
export function createScheduler({ store, scanner, startDelayMs = 10_000, log = console }) {
  const due = new Map();
  let timer = null;
  let stopped = false;
  let running = false;

  const intervalMs = (id) => store.data.regions[id].intervalMinutes * 60_000;
  const ids = () => Object.keys(store.data.regions);

  function arm() {
    clearTimeout(timer);
    timer = null;
    if (stopped) return;
    for (const id of ids()) if (!due.has(id)) due.set(id, Date.now() + intervalMs(id));
    if (due.size === 0) return;
    timer = setTimeout(tick, Math.max(0, Math.min(...due.values()) - Date.now()));
    timer.unref?.();
  }

  async function tick() {
    timer = null;
    // A region brought forward while a scan is running re-arms the timer; the scan in hand picks it up when it finishes.
    if (stopped || running) return;
    running = true;
    const now = Date.now();
    const ready = ids().filter((id) => (due.get(id) ?? Infinity) <= now);
    const was = new Map(ready.map((id) => [id, due.get(id)]));
    try {
      if (ready.length) await scanner.run({ regions: ready });
    } catch (err) {
      log.error("scan crashed:", err);
    } finally {
      running = false;
    }
    // A region that was brought forward again during its own scan (someone chose a campus there after its accounts were
    // read) keeps that time, so it is looked at once more instead of waiting out the interval.
    for (const id of ready) if (due.get(id) === was.get(id)) due.set(id, Date.now() + intervalMs(id));
    arm();
  }

  // Run the next scan for `regionId` (or every region) after `delayMs`.
  function setDue(regionId, delayMs) {
    for (const id of regionId ? [regionId] : ids()) if (store.data.regions[id]) due.set(id, Date.now() + delayMs);
    arm();
  }

  return {
    start: () => setDue(null, startDelayMs),
    // The interval of a region changed: count it from now.
    reschedule: (regionId) => {
      for (const id of regionId ? [regionId] : ids()) if (store.data.regions[id]) due.set(id, Date.now() + intervalMs(id));
      arm();
    },
    runSoon: (regionId) => setDue(regionId, 1_000),
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    // When a region is next scanned; with no region, the soonest of them.
    nextRunAt(regionId) {
      const at = regionId ? due.get(regionId) : due.size ? Math.min(...due.values()) : undefined;
      return at === undefined ? null : new Date(at);
    },
  };
}
