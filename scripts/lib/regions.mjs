// Where to look for each region we plan to run, so `npm run probe -- --region=cork` checks a region's sources the way
// the scanner would. Limerick is today's search; Cork and Galway are the January 2027 pilot (#26).
//
// Every Daft area and every Rent.ie and MyHome page below was loaded live on 2026-10-02. Two traps when adding a
// region: Daft turns an area name it doesn't know into a search of all Ireland, and Rent.ie turns one into its whole
// county's 20 newest adverts (look for a generic "Cork Lettings" title and exactly 20 adverts). Neither is an error.
//
// localityHints are a starting point from the neighbourhoods around each campus; check them by hand (#27).
// The UL accommodation board is Limerick-only, so Cork and Galway have no board until the Studentpad scraper (#25).
import { DEFAULT_CONFIG } from "../../src/config.js";
import { campusById } from "../../src/transit/campuses.js";

const SOURCES = ["daft", "rent", "myhome"];
const rent = (section, county, areas) => areas.map((a) => `https://www.rent.ie/${section}/${county}/${a}/`);
const GALWAY_AREAS = ["galway-city-centre", "newcastle", "shantalla", "rahoon", "salthill", "knocknacarra", "bohermore", "terryland", "mervue", "doughiska"];

export const REGIONS = {
  limerick: {
    name: "Limerick",
    campuses: ["ul", "mic", "tus-limerick"],
    config: {},
  },

  cork: {
    name: "Cork",
    campuses: ["ucc", "mtu-cork"],
    config: {
      daftLocation: "cork-city",
      sources: SOURCES,
      ulUrls: [],
      rentUrls: [
        ...rent("houses-to-let", "cork", ["cork-city-centre", "cork-city-suburbs", "wilton", "bishopstown", "victoria-cross", "glasheen", "ballintemple", "blackpool"]),
        ...rent("rooms-to-rent", "cork", ["cork-city-centre", "cork-city-suburbs", "wilton", "bishopstown", "glasheen", "blackpool"]),
      ],
      myhomeUrls: ["https://www.myhome.ie/rentals/cork/property-to-rent"],
      localityHints: ["wilton", "bishopstown", "gillabbey", "western road", "victoria cross", "sundays well", "mardyke", "model farm road"],
    },
  },

  galway: {
    name: "Galway",
    campuses: ["uog", "atu-galway"],
    config: {
      daftLocation: "galway-city",
      sources: SOURCES,
      ulUrls: [],
      rentUrls: [...rent("houses-to-let", "galway", GALWAY_AREAS), ...rent("rooms-to-rent", "galway", GALWAY_AREAS)],
      myhomeUrls: ["https://www.myhome.ie/rentals/galway/property-to-rent"],
      localityHints: ["newcastle", "shantalla", "dangan", "rahoon", "bohermore", "nuns island", "terryland", "mervue", "renmore", "doughiska"],
    },
  },
};

// The config input for a region: today's defaults, centred on the region's first campus, plus its own pages and settings.
export function regionConfig(id) {
  const region = REGIONS[id];
  if (!region) throw new Error(`unknown region "${id}" (known: ${Object.keys(REGIONS).join(", ")})`);
  const lead = campusById(region.campuses[0]);
  return {
    ...DEFAULT_CONFIG,
    center: { label: lead.name, lat: lead.lat, lng: lead.lng },
    ...region.config,
  };
}
