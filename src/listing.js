import { parsePriceMonthly } from "./text.js";

const ROOM_RE = /\b(room|rooms|share|sharing|shared|bedsit|single|double|twin|ensuite|en-suite|lodger|digs)\b/i;

export function guessKind(title = "", url = "") {
  return ROOM_RE.test(`${title} ${url}`) ? "room" : "property";
}

export function makeListing({
  source,
  sourceLabel,
  group = null,
  externalId,
  url,
  title,
  priceText = "",
  lat = null,
  lng = null,
  bedsText = null,
  propertyType = null,
  publishedAt = null,
  ownerOccupied = null,
  image = null,
  text = "",
  address = "",
  kind,
  section = null,
  pending = false,
}) {
  const bedsMatch = bedsText ? /(\d+)/.exec(bedsText) : null;
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lng);
  return {
    id: `${source}:${externalId}`,
    source,
    sourceLabel,
    group,
    section,
    kind: kind ?? guessKind(title, url),
    title,
    address,
    url,
    priceText,
    priceMonthly: parsePriceMonthly(priceText),
    bedsText,
    beds: bedsMatch ? Number(bedsMatch[1]) : null,
    propertyType,
    lat: hasCoords ? lat : null,
    lng: hasCoords ? lng : null,
    distanceSource: hasCoords ? "source" : null,
    publishedAt,
    ownerOccupied,
    image,
    text: [title, address, text].filter(Boolean).join(" \n "),
    pending,
  };
}
