import test from "node:test";
import assert from "node:assert/strict";
import { analyzeText, ownerOccupiedFromText, parseAvailability, parsePriceMonthly, weekdayOnlyFromText } from "../src/text.js";

const NOW = new Date("2026-09-30T12:00:00Z");

test("owner-occupied: explicit wording is detected", () => {
  for (const t of [
    "Double room in an owner-occupied house",
    "Owner occupied, quiet estate",
    "Live-in landlord, bills included",
    "Resident landlord on site",
    "The owner lives in the property",
    "Sharing with the owner, a couple in their 20s",
    "Room in a family home in Castletroy",
  ]) {
    assert.equal(ownerOccupiedFromText(t), true, t);
  }
});

test("owner-occupied: negations and absence", () => {
  assert.equal(ownerOccupiedFromText("Landlord does not live in the property"), false);
  assert.equal(ownerOccupiedFromText("No live-in landlord, all tenants"), false);
  assert.equal(ownerOccupiedFromText("Non-owner-occupied student house"), false);
  assert.notEqual(ownerOccupiedFromText("This house is not owner occupied"), true);
  assert.equal(ownerOccupiedFromText("Four students share, all double rooms"), null);
  assert.equal(ownerOccupiedFromText(""), null);
});

test("weekday-only lets are recognised", () => {
  for (const t of [
    "Available Monday to Friday only",
    "Sunday evening to Friday morning rental",
    "5-day rental, bills included",
    "Mon-Fri let",
    "weekdays only please",
    "5 day week",
  ]) {
    assert.equal(weekdayOnlyFromText(t), true, t);
  }
  for (const t of ["7 day access, full-time tenancy", "Requires 5 day notice", "Fully available, all week"]) {
    assert.equal(weekdayOnlyFromText(t), false, t);
  }
});

test("availability: explicit dd/mm/yyyy (Irish order)", () => {
  assert.equal(parseAvailability("Available from 01/09/2026", NOW).availableFrom, "2026-09-01");
  assert.equal(parseAvailability("Available: 15.10.26", NOW).availableFrom, "2026-10-15");
  assert.equal(parseAvailability("available from 31/02/2026", NOW).availableFrom, null, "invalid date");
});

test("availability: month names with and without days and years", () => {
  assert.equal(parseAvailability("Available from 1st October", NOW).availableFrom, "2026-10-01");
  assert.equal(parseAvailability("available from 15 October 2026", NOW).availableFrom, "2026-10-15");
  assert.equal(parseAvailability("Available from November", NOW).availableFrom, "2026-11-01");
});

test("availability: ranges and end dates", () => {
  const r = parseAvailability("Available September to May", NOW);
  assert.equal(r.availableFrom, "2026-09-01");
  assert.equal(r.availableTo, "2027-05-31");
  const r2 = parseAvailability("Available from 15 October 2026 until end of June", NOW);
  assert.equal(r2.availableFrom, "2026-10-15");
  assert.equal(r2.availableTo, "2027-06-30");
  assert.equal(parseAvailability("Let until June 2027", NOW).availableTo, "2027-06-30");
  assert.equal(parseAvailability("Sept 2026 - June 2027", NOW).availableTo, "2027-06-30");
});

test("availability: immediate", () => {
  const r = parseAvailability("Room available now, move in immediately", NOW);
  assert.equal(r.immediate, true);
  assert.equal(r.availableFrom, "2026-09-30");
  assert.equal(parseAvailability("Available immediately until June", NOW).availableTo, "2027-06-30");
});

test("availability: 'Available: Now' with a colon, as on the UL portal", () => {
  const r = parseAvailability("Available: Now 2 LMKP10131726 €850 Per person per month", NOW);
  assert.equal(r.immediate, true);
  assert.equal(r.availableFrom, "2026-09-30");
});

test("the UL 'Resident Landlord/Host Family' label is recognised as owner-occupied", () => {
  assert.equal(ownerOccupiedFromText("The Meadows, Limerick Resident Landlord/Host Family, Room in House / Apartment with other tenants"), true);
  assert.equal(ownerOccupiedFromText("Dublin Rd, Castletroy Room in House / Apartment with other tenants"), null);
});

test("availability: no false positives from ordinary words", () => {
  const r = parseAvailability("Close to the market, may suit a student. Marvellous location, from €650 per month.", NOW);
  assert.equal(r.availableFrom, null);
  assert.equal(r.availableTo, null);
});

test("analyzeText combines signals", () => {
  const a = analyzeText("Owner-occupied. Monday to Friday only. Available from 01/11/2026.", NOW);
  assert.equal(a.ownerOccupied, true);
  assert.equal(a.weekdayOnly, true);
  assert.equal(a.availableFrom, "2026-11-01");
});

test("price parsing covers weekly and per-person wording", () => {
  assert.equal(parsePriceMonthly("€650 per month"), 650);
  assert.equal(parsePriceMonthly("€150 per week"), 650);
  assert.equal(parsePriceMonthly("€150/week"), 650);
  assert.equal(parsePriceMonthly("€150 p/w"), 650);
  assert.equal(parsePriceMonthly("€1,250 per person per month"), 1250);
  assert.equal(parsePriceMonthly("Price on request"), null);
});
