// The campuses an account can choose and the regions they are searched in (#12, #27). A region is one place the sites are
// read for, however many campuses sit in it: the Daft area and the Rent.ie, MyHome and accommodation-board pages are
// fetched once per scan and every account in the region is matched against them.
//
// Region settings here are only the starting point. The admin's copy lives in the saved state and is what the scanner
// uses, so a changed Rent.ie page is an edit in the app, not a deploy. The campus entries are not editable in the app.
//
// Every Daft area and every Rent.ie and MyHome page was loaded live on 2026-10-02 (Cork, Galway) and 2026-10-05 (the
// Limerick city pages for Mary Immaculate College and TUS Limerick). Two traps when adding a region: Daft turns an area
// name it doesn't know into a search of all Ireland (the scanner reports that as an error), and Rent.ie turns one into
// its whole county's 20 newest adverts, which is no error at all (look for a generic "Cork Lettings" title and exactly 20
// adverts). Daft's city areas are areas, not points: `cork-city` returns the whole city even at 1 km, and the radius only
// adds a margin around it.
//
// localityHints are a starting point from the neighbourhoods around each campus; check them by hand (#27).
// The UL accommodation board is Limerick-only, so Cork and Galway have no board until the Studentpad scraper (#25).
// Campuses outside these regions (Dublin and the rest) are in the transport data but can't be chosen until their regions
// are set up (#28).
import { DEFAULT_CONFIG } from "./config.js";
import { CAMPUSES, campusById } from "./transit/campuses.js";

const rent = (section, county, areas) => areas.map((a) => `https://www.rent.ie/${section}/${county}/${a}/`);
const GALWAY_AREAS = ["galway-city-centre", "newcastle", "shantalla", "rahoon", "salthill", "knocknacarra", "bohermore", "terryland", "mervue", "doughiska"];
const SOURCES = ["daft", "rent", "myhome"];

// The settings every region starts with; each seed below overrides what differs.
const REGION_DEFAULTS = {
  enabled: true,
  intervalMinutes: DEFAULT_CONFIG.intervalMinutes,
  geocode: DEFAULT_CONFIG.geocode,
  respectRobots: DEFAULT_CONFIG.respectRobots,
  maxDetailFetches: DEFAULT_CONFIG.maxDetailFetches,
  maxPages: DEFAULT_CONFIG.maxPages,
  webUrls: [],
};

export const REGION_SEEDS = {
  // Today's search: the Daft area is centred on UL and 10 km reaches Mary Immaculate College and TUS Limerick as well (about
  // 5 km away), with the same results as the city-wide area.
  limerick: {
    ...REGION_DEFAULTS,
    name: "Limerick",
    radiusKm: 10,
    daftLocation: DEFAULT_CONFIG.daftLocation,
    sources: [...DEFAULT_CONFIG.sources],
    ulUrls: [...DEFAULT_CONFIG.ulUrls],
    rentUrls: [...DEFAULT_CONFIG.rentUrls],
    myhomeUrls: [...DEFAULT_CONFIG.myhomeUrls],
  },

  // A city area covers the whole city at any radius, so 5 km is a margin for homes just outside it.
  cork: {
    ...REGION_DEFAULTS,
    name: "Cork",
    radiusKm: 5,
    daftLocation: "cork-city",
    sources: SOURCES,
    ulUrls: [],
    rentUrls: [
      ...rent("houses-to-let", "cork", ["cork-city-centre", "cork-city-suburbs", "wilton", "bishopstown", "victoria-cross", "glasheen", "ballintemple", "blackpool"]),
      ...rent("rooms-to-rent", "cork", ["cork-city-centre", "cork-city-suburbs", "wilton", "bishopstown", "glasheen", "blackpool"]),
    ],
    myhomeUrls: ["https://www.myhome.ie/rentals/cork/property-to-rent"],
  },

  galway: {
    ...REGION_DEFAULTS,
    name: "Galway",
    radiusKm: 5,
    daftLocation: "galway-city",
    sources: SOURCES,
    ulUrls: [],
    rentUrls: [...rent("houses-to-let", "galway", GALWAY_AREAS), ...rent("rooms-to-rent", "galway", GALWAY_AREAS)],
    myhomeUrls: ["https://www.myhome.ie/rentals/galway/property-to-rent"],
  },
};

// Rent.ie pages for the city side of Limerick, read only while someone has chosen Mary Immaculate College or TUS Limerick,
// so a search that is only for UL doesn't spend its requests on them.
const LIMERICK_CITY = ["limerick-city-centre", "thomondgate", "ennis-road", "north-circular-road", "south-circular-road", "garryowen"];

// The campuses that can be chosen. `maxRadiusKm` is how far out an account may ask to look; it can't be more than the
// region's search reaches. `rentUrls`, `myhomeUrls` and `ulUrls` are extra pages for this campus alone.
export const CAMPUS_DETAILS = {
  ul: {
    region: "limerick",
    localityHints: [...DEFAULT_CONFIG.localityHints],
  },
  mic: {
    region: "limerick",
    localityHints: ["thomondgate", "ennis road", "south circular road", "north circular road", "garryowen", "ballinacurra"],
    rentUrls: [...rent("houses-to-let", "limerick", [...LIMERICK_CITY, "ballinacurra"]), ...rent("rooms-to-rent", "limerick", [...LIMERICK_CITY, "ballinacurra"])],
  },
  "tus-limerick": {
    region: "limerick",
    // Moylish is further out from UL than the others, so a 5 km search around it would pass the edge of what the region fetches.
    maxRadiusKm: 4.5,
    localityHints: ["moylish", "caherdavin", "ennis road", "corbally", "clareview", "thomondgate"],
    rentUrls: [...rent("houses-to-let", "limerick", [...LIMERICK_CITY, "caherdavin"]), ...rent("rooms-to-rent", "limerick", [...LIMERICK_CITY, "caherdavin", "corbally"])],
  },

  ucc: {
    region: "cork",
    localityHints: ["gillabbey", "western road", "victoria cross", "sundays well", "mardyke"],
  },
  "mtu-cork": {
    region: "cork",
    localityHints: ["bishopstown", "wilton", "model farm road"],
  },

  uog: {
    region: "galway",
    localityHints: ["newcastle", "shantalla", "dangan", "rahoon", "bohermore", "nuns island", "terryland"],
  },
  "atu-galway": {
    region: "galway",
    localityHints: ["renmore", "doughiska", "mervue", "bohermore", "terryland"],
  },
};

const DEFAULT_CAMPUS_LIMITS = { defaultRadiusKm: DEFAULT_CONFIG.radiusKm, maxRadiusKm: 5 };

// A campus an account can choose, with its position from the transport catalogue and its limits, or null.
export function searchCampus(id) {
  const details = CAMPUS_DETAILS[id];
  const campus = campusById(id);
  if (!details || !campus) return null;
  const { region, ...rest } = details;
  return { ...DEFAULT_CAMPUS_LIMITS, ...rest, id, regionId: region, name: campus.name, short: campus.short, lat: campus.lat, lng: campus.lng };
}

// Every campus that can be chosen, in the order of the transport catalogue.
export const searchCampuses = () => CAMPUSES.map((c) => searchCampus(c.id)).filter(Boolean);

export const campusesInRegion = (regionId) => searchCampuses().filter((c) => c.regionId === regionId);

// The point a region's search is centred on, for looking addresses up: its first campus.
export function regionCentre(regionId) {
  const lead = campusesInRegion(regionId)[0];
  return lead ? { lat: lead.lat, lng: lead.lng, label: lead.name } : null;
}
