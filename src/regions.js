import { REGION_SEEDS, searchCampus } from "./catalogue.js";
import { activeRegionIds } from "./searches.js";

// What a region has done lately, kept apart from its settings so that saving the settings doesn't lose it.
export const regionStatus = (store, id) => (store.data.regionStatus[id] ??= { failureCount: 0, lastRun: null, sourceHealth: {}, pendingAttempts: {} });

export const regionName = (store, id) => store.data.regions[id]?.name ?? REGION_SEEDS[id]?.name ?? id;

// The regions that are switched on and have someone watching in them. Nothing else is fetched.
export const scannableRegionIds = (store) => activeRegionIds(store).filter((id) => store.data.regions[id]?.enabled);

// The sites that have to be reachable for anyone to be alerted: those of the regions being scanned. The laptop agent
// is only worth a warning if one of these needs it.
export function activeSources(store) {
  return [...new Set(scannableRegionIds(store).flatMap((id) => store.data.regions[id].sources))];
}

// What a region's collect is told to look for: its own settings, with the Rent.ie, MyHome and accommodation-board pages
// of the campuses somebody has chosen added to them, and nobody's preferences applied.
export function collectionPlan(store, regionId, campusIds) {
  const region = store.data.regions[regionId];
  const campuses = [...new Set(campusIds)].map(searchCampus).filter(Boolean);
  const pages = (key) => [...new Set([...region[key], ...campuses.flatMap((c) => c[key] ?? [])])];
  return { region, campuses, ulUrls: pages("ulUrls"), rentUrls: pages("rentUrls"), myhomeUrls: pages("myhomeUrls") };
}
