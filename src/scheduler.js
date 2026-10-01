export function createScheduler({ store, scanner, startDelayMs = 10_000, log = console }) {
  let timer = null;
  let stopped = false;
  let nextRunAt = null;

  async function tick() {
    timer = null;
    if (stopped) return;
    if (store.data.config.enabled) {
      try {
        await scanner.run();
      } catch (err) {
        log.error("scan crashed:", err);
      }
    }
    schedule(store.data.config.intervalMinutes * 60_000);
  }

  function schedule(delayMs) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    nextRunAt = new Date(Date.now() + delayMs);
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  }

  return {
    start: () => schedule(startDelayMs),
    reschedule: () => schedule(store.data.config.intervalMinutes * 60_000),
    runSoon: () => schedule(1_000),
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    nextRunAt: () => nextRunAt,
  };
}
