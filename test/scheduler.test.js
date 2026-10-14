import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler } from "../src/scheduler.js";
import { tempStore } from "./helpers.js";

const MINUTE = 60_000;
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, { limerick = 30, cork = 60 } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.parse("2026-10-05T10:00:00Z") });
  const { store } = tempStore();
  store.data.regions.limerick.intervalMinutes = limerick;
  store.data.regions.cork.intervalMinutes = cork;
  const runs = [];
  let crash = false;
  const scanner = {
    async run(opts) {
      runs.push(opts.regions);
      if (crash) throw new Error("boom");
    },
  };
  const errors = [];
  const scheduler = createScheduler({ store, scanner, startDelayMs: 10_000, log: { error: (...a) => errors.push(a.join(" ")) } });
  const advance = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { store, runs, errors, scheduler, advance, crash: (v) => (crash = v) };
}

test("each region is scanned on its own interval", async (t) => {
  const { runs, scheduler, advance } = setup(t);
  scheduler.start();
  await advance(10_000);
  assert.deepEqual(runs, [["limerick", "cork", "galway"]], "everything is due at the start");

  await advance(30 * MINUTE);
  assert.deepEqual(runs.at(-1), ["limerick", "galway"], "Limerick and Galway are on 30 minutes, Cork is not due yet");
  await advance(30 * MINUTE);
  assert.deepEqual(runs.at(-1), ["limerick", "cork", "galway"], "Cork's hour has come round");
  scheduler.stop();
});

test("a region can be brought forward without disturbing the others", async (t) => {
  const { runs, scheduler, advance } = setup(t);
  scheduler.start();
  await advance(10_000);
  runs.length = 0;

  scheduler.runSoon("cork");
  await advance(1_000);
  assert.deepEqual(runs, [["cork"]]);
  assert.equal(scheduler.nextRunAt("limerick").getTime(), Date.parse("2026-10-05T10:00:10Z") + 30 * MINUTE, "Limerick keeps its own time");
  assert.equal(scheduler.nextRunAt("cork").getTime(), Date.parse("2026-10-05T10:00:11Z") + 60 * MINUTE, "and Cork's interval counts from when it ran");
  scheduler.stop();
});

test("changing a region's interval counts from now, for that region only", async (t) => {
  const { store, scheduler, advance } = setup(t);
  scheduler.start();
  await advance(10_000);
  const limerick = scheduler.nextRunAt("limerick").getTime();
  store.data.regions.cork.intervalMinutes = 5;
  scheduler.reschedule("cork");
  assert.equal(scheduler.nextRunAt("cork").getTime(), Date.now() + 5 * MINUTE);
  assert.equal(scheduler.nextRunAt("limerick").getTime(), limerick);
  assert.equal(scheduler.nextRunAt().getTime(), Date.now() + 5 * MINUTE, "with no region, the soonest");
  scheduler.stop();
});

test("a scan that crashes is logged and the next one still happens", async (t) => {
  const { runs, errors, scheduler, advance, crash } = setup(t);
  crash(true);
  scheduler.start();
  await advance(10_000);
  assert.match(errors[0], /scan crashed:.*boom/);
  crash(false);
  await advance(30 * MINUTE);
  assert.equal(runs.length, 2);
  scheduler.stop();
});

test("a stopped scheduler runs nothing more, and a scheduler with nothing due doesn't ask for a scan", async (t) => {
  const { runs, scheduler, advance } = setup(t);
  scheduler.start();
  scheduler.stop();
  await advance(24 * 60 * MINUTE);
  assert.deepEqual(runs, []);
  assert.equal(scheduler.nextRunAt("nowhere"), null);
});
