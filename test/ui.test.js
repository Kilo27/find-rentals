import test from "node:test";
import assert from "node:assert/strict";

// ui.js builds real DOM nodes, and this project has no DOM library, so a small stand-in is enough to check what it
// puts where. It has to be in place before the module is loaded.
class FakeNode {}
class FakeText extends FakeNode {
  constructor(text) {
    super();
    this.text = text;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tag = tag;
    this.attrs = {};
    this.children = [];
  }
  setAttribute(k, v) {
    this.attrs[k] = v;
  }
  addEventListener() {}
  append(...kids) {
    this.children.push(...kids);
  }
}
globalThis.Node = FakeNode;
globalThis.document = { createElement: (tag) => new FakeElement(tag), createTextNode: (text) => new FakeText(text) };

const { h, describeMatch, leadRow } = await import("../public/ui.js");

test("h: arrays nested inside arrays become real children, never printed objects", () => {
  const a = h("a");
  const b = h("button");
  const c = h("button");
  // The shape a card's action row had: a conditional group inside the list of children.
  const row = h("div", { class: "actions" }, [a, b, true ? [c, h("button")] : null], null, false, "text");
  assert.equal(row.children.length, 5);
  assert.ok(row.children.every((n) => n instanceof FakeNode), "every child is a node");
  assert.ok(!row.children.some((n) => n instanceof FakeText && /object/.test(n.text)), "nothing was stringified");
  assert.deepEqual(row.children.slice(0, 3), [a, b, c]);
  assert.equal(row.children[4].text, "text");
});

test("h: null, undefined and false children are skipped, and attributes are set", () => {
  const el = h("div", { class: "x", hidden: true, "aria-label": "y", missing: false, gone: null }, null, undefined, false, "ok");
  assert.equal(el.className, "x");
  assert.equal(el.attrs.hidden, "");
  assert.equal(el.attrs["aria-label"], "y");
  assert.ok(!("missing" in el.attrs) && !("gone" in el.attrs));
  assert.equal(el.children.length, 1);
});

const listing = (over = {}) => ({ id: "daft:1", title: "T", priceMonthly: 1650, sourceLabel: "Daft.ie", bedsText: "3 Beds", propertyType: "House", flags: [], ...over });
const config = { radiusKm: 2 };

test("card: how near it is rides with the price, and the meta line no longer repeats it", () => {
  const d = describeMatch(listing({ distanceKm: 0.9, distanceSource: "source" }), config);
  assert.equal(d.price, "€1,650/mo");
  assert.deepEqual(d.near, { text: "0.9 km", note: null, tone: null });
  assert.equal(d.meta, "3 Beds · House · Daft.ie");
});

test("card: approximate and area-only distances say so once, in the lead", () => {
  const area = describeMatch(listing({ distanceKm: 1.7, distanceSource: "geocoded-area", flags: ["distance-approx"] }), config);
  assert.deepEqual(area.near, { text: "~1.7 km", note: "area only", tone: "approx" });
  const addr = describeMatch(listing({ distanceKm: 0.6, distanceSource: "geocoded" }), config);
  assert.equal(addr.near.note, "from address");
});

test("card: an unverified distance has no figure, and is flagged by the badge alone", () => {
  const d = describeMatch(listing({ distanceKm: null, flags: ["distance-unverified"] }), config);
  assert.equal(d.near, null);
  assert.ok(d.badges.some((b) => b.text === "check distance"));
  assert.ok(!/unverified/.test(d.meta));
});

test("card: a home beyond the radius leads with the ride to campus", () => {
  const transit = { campuses: [{ short: "UL", options: [{ mode: "bus", label: "304A", stop: "Annacotty Cross", distM: 250, mins: 14, perDay: 38 }] }] };
  const d = describeMatch(listing({ distanceKm: 4.1, flags: ["transit-access"], transit }), config);
  assert.deepEqual(d.near, { text: "4.1 km", note: "14 min to UL by bus", tone: "via" });
  assert.match(d.transit[0], /304A · Annacotty Cross, 250 m · 14 min to UL · 38 a day/);
});

test("card: leadRow puts the price and the distance in one row", () => {
  const row = leadRow(describeMatch(listing({ distanceKm: 0.9, distanceSource: "source" }), config));
  assert.equal(row.attrs.class ?? row.className, row.className);
  assert.equal(row.children.length, 2);
  assert.equal(row.children[0].className, "price");
  assert.match(row.children[1].className, /^near/);
});
