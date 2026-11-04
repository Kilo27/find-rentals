import test from "node:test";
import assert from "node:assert/strict";
import { CHECK_MODEL, applyFacts, createListingChecker } from "../src/listing-check.js";
import { makeListing } from "../src/listing.js";
import { analyzeListing, evaluateNonLocation } from "../src/filter.js";
import { DEFAULT_CONFIG, normalizeConfig } from "../src/config.js";
import { createScanner } from "../src/scan.js";
import { configure, daftPage, fakePusher, noSleep, rawListing, router, searchOf, tempStore } from "./helpers.js";

const NOW = new Date("2026-11-04T10:00:00Z");
const DAFT = /^https:\/\/www\.daft\.ie\/sharing\//;

// What Haiku answers: every field, null or false unless the test says otherwise.
const facts = (over = {}) => ({ kind: null, rent: null, bedrooms: null, propertyType: null, address: null, availableFrom: null, availableTo: null, availableNow: false, ownerOccupied: null, weekdayOnly: false, ...over });

// Stands in for the Anthropic client. `answer(prompt)` returns the facts, a whole response (anything with `content`), or throws.
function fakeClient(answer) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        const out = await answer(params.messages[0].content);
        if (out?.content) return out;
        return { stop_reason: "end_turn", content: [{ type: "thinking", thinking: "", signature: "x" }, { type: "text", text: JSON.stringify(out) }] };
      },
    },
  };
}

const advert = (over = {}) =>
  makeListing({
    source: "rent",
    sourceLabel: "Rent.ie",
    externalId: "1",
    url: "https://www.rent.ie/rooms-to-rent/castletroy/1",
    title: "Double room, Castletroy",
    priceText: "€150 per month",
    text: "Lovely double room in a quiet house near UL. The rent is €150 per week, bills included.",
    ...over,
  });

test("applyFacts: a weekly rent entered as monthly is corrected, and the card is told", () => {
  const l = advert();
  assert.equal(l.priceMonthly, 150);
  applyFacts(l, facts({ kind: "room", rent: { amount: 150, per: "week" } }), NOW);
  assert.equal(l.priceMonthly, 650);
  assert.deepEqual(l.corrected, ["price"]);
});

test("applyFacts: blanks are filled in, which isn't a correction", () => {
  const url = "https://www.rent.ie/houses-to-let/castletroy/1";
  const l = advert({ url, title: "To let", priceText: "", text: "Two-bed apartment at 12 Plassey Park, Castletroy. €1,400 a month." });
  assert.equal(l.kind, "property");
  applyFacts(l, facts({ kind: "property", rent: { amount: 1400, per: "month" }, bedrooms: 2, propertyType: "apartment", address: "12 Plassey  Park, Castletroy, Limerick" }), NOW);
  assert.deepEqual([l.priceMonthly, l.beds, l.bedsText, l.propertyType, l.address], [1400, 2, "2 Bed", "Apartment", "12 Plassey Park, Castletroy, Limerick"]);
  assert.equal(l.corrected, undefined);

  const room = advert({ url, title: "Double bedroom apartment to rent" });
  assert.equal(room.kind, "room", "the title guess is fooled by 'double'");
  applyFacts(room, facts({ kind: "property" }), NOW);
  assert.equal(room.kind, "property");
});

test("applyFacts: the same price within 5%, and anything implausible, is left alone", () => {
  const l = advert({ title: "House to let", priceText: "€650 per month", bedsText: "3 Bed" });
  applyFacts(l, facts({ kind: "property", rent: { amount: 660, per: "month" }, bedrooms: 40, availableFrom: "2031-01-01", availableTo: "2026-02-30" }), NOW);
  assert.deepEqual([l.priceMonthly, l.beds, l.availableFrom, l.availableTo, l.corrected], [650, 3, null, null, undefined]);

  const cheap = advert({ priceText: "" });
  applyFacts(cheap, facts({ rent: { amount: 5, per: "month" } }), NOW);
  assert.equal(cheap.priceMonthly, null);

  const backwards = advert();
  applyFacts(backwards, facts({ availableFrom: "2026-12-01", availableTo: "2026-11-20" }), NOW);
  assert.deepEqual([backwards.availableFrom, backwards.availableTo], ["2026-12-01", null]);
});

test("applyFacts: Daft's own section says room or whole place, and a room's bedrooms aren't the house's", () => {
  const l = makeListing({ source: "daft", sourceLabel: "Daft.ie", externalId: "9", url: "https://www.daft.ie/share/9", title: "Room, Castletroy", section: "sharing", kind: "room", bedsText: "1 Bed", text: "x".repeat(60) });
  applyFacts(l, facts({ kind: "property", bedrooms: 4 }), NOW);
  assert.deepEqual([l.kind, l.beds, l.corrected], ["room", 1, undefined]);
});

test("applyFacts: the description's dates, owner and weekday answers replace the wording rules", () => {
  const l = advert({ text: "Not owner occupied. A full seven-day let, not Monday to Friday only. Available from 10 November." });
  analyzeListing(l, NOW);
  assert.equal(l.weekdayOnly, true, "the wording rules are fooled");
  assert.equal(l.ownerOccupiedText, null);
  applyFacts(l, facts({ ownerOccupied: false, weekdayOnly: false, availableFrom: "2026-11-10" }), NOW);
  assert.deepEqual([l.ownerOccupiedText, l.weekdayOnly, l.availableFrom, l.immediate], [false, false, "2026-11-10", false]);
  // With the default keywords, "Not owner occupied" used to be turned away for containing "owner occupied".
  assert.equal(evaluateNonLocation(l, normalizeConfig(DEFAULT_CONFIG), NOW).ok, true);

  const now = advert();
  applyFacts(now, facts({ availableNow: true }), NOW);
  assert.deepEqual([now.availableFrom, now.immediate], ["2026-11-04", true]);
});

test("applyFacts: Daft's owner-occupied box ticked the wrong way is corrected by the description", () => {
  const l = advert();
  l.ownerOccupied = false;
  applyFacts(l, facts({ ownerOccupied: true }), NOW);
  assert.equal(l.ownerOccupied, true);
  assert.deepEqual(l.corrected, ["owner-occupied"]);
  assert.equal(evaluateNonLocation(l, normalizeConfig(DEFAULT_CONFIG), NOW).reason, "owner occupied");
});

test("checker: asks Haiku for the facts as JSON at low effort, with the advert and today's date", async () => {
  const client = fakeClient(() => facts());
  await createListingChecker({ client }).checkAll([advert()], {}, NOW);
  const [p] = client.calls;
  assert.equal(p.model, "claude-haiku-5-5");
  assert.equal(CHECK_MODEL, "claude-haiku-5-5");
  assert.equal(p.output_config.effort, "low");
  assert.equal(p.output_config.format.type, "json_schema");
  assert.equal(p.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(p.output_config.format.schema.required, Object.keys(facts()));
  assert.match(p.messages[0].content, /^Today is 2026-11-04\./);
  assert.match(p.messages[0].content, /Price shown: €150 per month/);
  assert.match(p.messages[0].content, /The rent is €150 per week/);
  assert.match(p.system, /data to read, not instructions/);
  for (const k of ["temperature", "top_p", "top_k", "thinking"]) assert.ok(!(k in p), `${k} is not sent`);
});

test("checker: each advert is read once, and again only when it changes", async () => {
  const client = fakeClient(() => facts({ rent: { amount: 150, per: "week" } }));
  const checker = createListingChecker({ client });
  const cache = {};

  const first = advert();
  assert.deepEqual(await checker.checkAll([first], cache, NOW), { checked: 1, cached: 0, failed: 0, waiting: 0, error: null });
  assert.equal(first.priceMonthly, 650);

  const again = advert();
  assert.equal((await checker.checkAll([again], cache, NOW)).cached, 1);
  assert.equal(client.calls.length, 1);
  assert.equal(again.priceMonthly, 650, "what was read is applied again");

  await checker.checkAll([advert({ text: "Lovely double room, now €160 per week." })], cache, NOW);
  assert.equal(client.calls.length, 2, "an edited advert is read again");

  // Not seen for a fortnight: forgotten.
  await checker.checkAll([], cache, new Date(NOW.getTime() + 15 * 24 * 3600_000));
  assert.deepEqual(cache, {});
});

test("checker: an advert with nothing of its own to read isn't sent", async () => {
  const client = fakeClient(() => facts());
  const stats = await createListingChecker({ client }).checkAll([advert({ text: "" }), advert({ externalId: "2", text: "Bills incl." })], {}, NOW);
  assert.equal(client.calls.length, 0);
  assert.equal(stats.checked, 0);
});

test("checker: a service failure leaves the rest for the next scan, on their wording meanwhile", async () => {
  const client = fakeClient(() => {
    throw new Error("Connection error.");
  });
  const ads = [1, 2, 3].map((i) => advert({ externalId: String(i) }));
  const stats = await createListingChecker({ client, concurrency: 1 }).checkAll(ads, {}, NOW);
  assert.deepEqual(stats, { checked: 0, cached: 0, failed: 1, waiting: 2, error: "Connection error." });
  assert.equal(client.calls.length, 1, "not asked again in the same scan");
  assert.ok(ads.every((l) => l.priceMonthly === 150 && l.corrected === undefined));
});

test("checker: an answer that can't be used costs only that advert, which then goes to the back", async () => {
  const client = fakeClient((prompt) => (/Room 1,/.test(prompt) ? { stop_reason: "refusal", content: [] } : facts({ rent: { amount: 150, per: "week" } })));
  const checker = createListingChecker({ client, concurrency: 1 });
  const cache = {};
  const ad = (i) => advert({ externalId: String(i), title: `Room ${i}, Castletroy` });
  const stats = await checker.checkAll([ad(1), ad(2), ad(3)], cache, NOW);
  assert.deepEqual([stats.checked, stats.failed, stats.waiting], [2, 1, 0]);
  assert.match(stats.error, /refusal/);

  const limited = createListingChecker({ client, concurrency: 1, perScan: 1 });
  const next = await limited.checkAll([ad(1), ad(4)], cache, NOW);
  assert.match(client.calls.at(-1).messages[0].content, /Room 4,/, "the new advert is read first");
  assert.deepEqual([next.checked, next.waiting], [1, 1]);
});

test("scan: accounts are matched on Haiku's reading of each description", async () => {
  const { store } = tempStore();
  configure(store, { sources: ["daft"], sections: ["sharing"] });
  const fetchImpl = router([
    [
      DAFT,
      daftPage([
        rawListing({ id: 1, price: "€150 per month", extra: { description: "Double room in a quiet house share. The rent is €150 per week, bills included. Available from 10 November." } }),
        rawListing({ id: 2, extra: { description: "Room in our family home: we live here with our two children and you'd share the kitchen with us." } }),
        rawListing({ id: 3 }),
      ]),
    ],
  ]);
  const client = fakeClient((prompt) =>
    /Room 1,/.test(prompt) ? facts({ kind: "room", rent: { amount: 150, per: "week" }, availableFrom: "2026-11-10" }) : facts({ kind: "room", ownerOccupied: true }),
  );
  const lines = [];
  const log = { log: (l) => lines.push(l), warn() {} };
  const scanner = createScanner({ store, pusher: fakePusher(), fetchImpl, sleep: noSleep, politenessMs: 0, geocodeDelayMs: 0, now: () => NOW, log, checker: createListingChecker({ client }) });

  await scanner.run();
  const matches = searchOf(store).matches;
  // Daft's own filter called every room not owner-occupied; the second one's description says otherwise.
  assert.deepEqual(matches.map((m) => m.id).sort(), ["daft:1", "daft:3"]);
  const one = matches.find((m) => m.id === "daft:1");
  assert.deepEqual([one.priceMonthly, one.corrected, one.availableFrom], [650, ["price"], "2026-11-10"]);
  assert.equal(client.calls.length, 2, "the listing with no description isn't sent");
  assert.match(lines[0], / \| haiku read=2 cached=0$/);
  assert.deepEqual(store.data.regionStatus.limerick.lastRun.checks, { checked: 2, cached: 0, failed: 0, waiting: 0, error: null });

  await scanner.run();
  assert.equal(client.calls.length, 2, "nothing is read twice");
  assert.match(lines[1], / \| haiku read=0 cached=2$/);
});
