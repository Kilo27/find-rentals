// The campuses an account can choose and the regions they are searched in (#12, #27). A region is one place the sites are
// read for, however many campuses sit in it: the Daft area and the Rent.ie, MyHome and accommodation-board pages are
// fetched once per scan and every account in the region is matched against them.
//
// Region settings here are only the starting point. The admin's copy lives in the saved state and is what the scanner
// uses, so a changed Rent.ie page is an edit in the app, not a deploy. The campus entries are not editable in the app.
//
// Every Daft area and every Rent.ie and MyHome page was loaded live on 2026-10-02 (Cork, Galway), 2026-10-05 (the
// Limerick city pages for Mary Immaculate College and TUS Limerick) and 2026-10-25 (Dublin). Two traps when adding a
// region: Daft turns an area name it doesn't know into a search of all Ireland (the scanner reports that as an error),
// and Rent.ie turns one into its whole county's 20 newest adverts, which is no error at all (look for a generic "Cork
// Lettings" title and exactly 20 adverts). Daft's city areas are areas, not points: `cork-city` returns the whole city
// even at 1 km, and the radius only adds a margin around it.
//
// localityHints are a starting point from the neighbourhoods around each campus; check them by hand (#27). They are
// matched as whole words, so "dublin 2" doesn't take in Dublin 20, 22 or 24.
// The UL accommodation board is Limerick-only, so Cork and Galway have no board until the Studentpad scraper (#25).
// Dublin's college boards all need a student login (#25 puts those off-limits), so they are listed for the student to
// check themselves (`collegeHousing`) instead of being read. Campuses outside these regions (Maynooth and the rest) are
// in the transport data but can't be chosen until their regions are set up (#28).
import { DEFAULT_CONFIG } from "./config.js";
import { CAMPUSES, campusById } from "./transit/campuses.js";

const rent = (section, county, areas) => areas.map((a) => `https://www.rent.ie/${section}/${county}/${a}/`);
const rentBoth = (county, areas) => [...rent("houses-to-let", county, areas), ...rent("rooms-to-rent", county, areas)];
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

  // One region for every Dublin campus. Daft's `dublin-city` is the whole city (all the postal districts, Tallaght and
  // Blanchardstown included) and 5 km is a margin for Blackrock, Stillorgan and the other places just outside it. Daft is
  // read newest first, and on 2026-10-25 its 80 newest within this area went back 68 hours for houses and for rooms
  // alike, so one search finds what is new for every campus and splitting the city would only ask Daft more often.
  // Rent.ie and MyHome are only read near the campuses somebody has chosen (see CAMPUS_DETAILS): their Dublin-wide pages
  // show 20 adverts of the hundreds there are, and MyHome doesn't put the newest first.
  dublin: {
    ...REGION_DEFAULTS,
    name: "Dublin",
    radiusKm: 5,
    daftLocation: "dublin-city",
    sources: SOURCES,
    ulUrls: [],
    rentUrls: [],
    myhomeUrls: [],
  },
};

// Rent.ie pages for the city side of Limerick, read only while someone has chosen Mary Immaculate College or TUS Limerick,
// so a search that is only for UL doesn't spend its requests on them.
const LIMERICK_CITY = ["limerick-city-centre", "thomondgate", "ennis-road", "north-circular-road", "south-circular-road", "garryowen"];

// Dublin pages for one campus. Rent.ie's named areas only: its postal-district pages sit under /renting_*/, which its
// robots.txt disallows, and an area page already takes in the streets around it. MyHome's postal-district pages hold 31
// adverts or fewer (2026-10-25), so the three pages it is read to cover each one.
const dublinPages = (rentAreas, districts) => ({
  rentUrls: rentBoth("dublin", rentAreas),
  myhomeUrls: districts.map((d) => `https://www.myhome.ie/rentals/dublin-${d}/property-to-rent`),
});

// The college's own accommodation services, which ASAP can't watch: residences are applied for through the college,
// and every Dublin college's listing board needs a student login (#25). They are shown with the campus so the student
// knows to check them, instead of taking the silence to mean there is nothing there.
const TCD_HOUSING = [
  { name: "Trinity residences", url: "https://www.tcd.ie/accommodation/", note: "Rooms on campus, in Trinity Hall and in Trinity's partner residences. Apply through Trinity." },
  { name: "Students' Union accommodation listings", url: "https://www.tcdsuaccommodation.org/", note: "Rooms and digs offered to Trinity students. Sign in with your tcd.ie email." },
];
const UCD_HOUSING = [
  { name: "UCD Residences", url: "https://www.ucd.ie/residences/", note: "Rooms on the Belfield campus. Apply through UCD." },
  { name: "UCD Accommodation Pad", url: "https://www.ucdaccommodationpad.ie/", note: "UCD's listings of rooms, digs, flats and houses from local landlords. Register with your UCD email." },
];
const DCU_HOUSING = [
  { name: "DCU Accommodation", url: "https://www.dcuaccommodation.ie/", note: "Rooms on the Glasnevin, St Patrick's and All Hallows campuses. Apply through DCU." },
  { name: "DCU Studentpad", url: "https://www.dcustudentpad.ie/", note: "The Students' Union's listings, mostly digs (a room in a family home). Sign in with your DCU email." },
];
const TUD_HOUSING = [
  { name: "TU Dublin Studentpad", url: "https://www.tudublinstudentpad.ie/", note: "Digs, rooms and student residences near every TU Dublin campus. Register with your TU Dublin email." },
  { name: "TU Dublin accommodation advice", url: "https://www.tudublin.ie/for-students/student-services-and-support/accommodation--living-in-dublin/", note: "The Student Accommodation team's guide to finding a place." },
];

// The campuses that can be chosen. `maxRadiusKm` is how far out an account may ask to look; it can't be more than the
// region's search reaches. `rentUrls`, `myhomeUrls` and `ulUrls` are extra pages for this campus alone.
// `collegeHousing` is the college's own accommodation, shown to the student but not read (see TCD_HOUSING).
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

  // Dublin. Every campus is inside the area Daft is searched in, so each may look the full 5 km out.
  tcd: {
    region: "dublin",
    localityHints: ["temple bar", "pearse street", "dublin 2", "dublin 1", "grand canal dock", "ringsend", "portobello", "camden street", "smithfield", "ifsc", "christchurch"],
    ...dublinPages(["temple-bar", "grand-canal-dock", "portobello", "ifsc", "smithfield"], [2, 1]),
    collegeHousing: TCD_HOUSING,
  },
  ucd: {
    region: "dublin",
    localityHints: ["belfield", "clonskeagh", "donnybrook", "dublin 4", "booterstown", "mount merrion", "stillorgan", "goatstown", "milltown", "windy arbour", "ballsbridge", "dublin 14"],
    ...dublinPages(["belfield", "clonskeagh", "donnybrook", "booterstown", "mount-merrion", "stillorgan"], [4, 14]),
    collegeHousing: UCD_HOUSING,
  },
  "dcu-glasnevin": {
    region: "dublin",
    localityHints: ["glasnevin", "dublin 9", "drumcondra", "whitehall", "santry", "ballymun", "beaumont", "dublin 11", "griffith avenue", "collins avenue"],
    ...dublinPages(["glasnevin", "drumcondra", "whitehall", "santry", "ballymun", "beaumont"], [9, 11]),
    collegeHousing: DCU_HOUSING,
  },
  "dcu-stpats": {
    region: "dublin",
    localityHints: ["drumcondra", "dublin 9", "glasnevin", "whitehall", "phibsborough", "marino", "fairview", "dublin 3", "ballybough", "griffith avenue"],
    ...dublinPages(["drumcondra", "glasnevin", "whitehall", "marino", "fairview", "phibsborough"], [9, 3]),
    collegeHousing: DCU_HOUSING,
  },
  "tud-grangegorman": {
    region: "dublin",
    localityHints: ["grangegorman", "dublin 7", "phibsborough", "stoneybatter", "smithfield", "cabra", "north circular road", "arbour hill", "broadstone"],
    ...dublinPages(["phibsborough", "stoneybatter", "smithfield", "cabra", "north-circular-road"], [7]),
    collegeHousing: TUD_HOUSING,
  },
  "tud-city": {
    region: "dublin",
    localityHints: ["aungier street", "camden street", "dublin 2", "dublin 8", "portobello", "the coombe", "christchurch", "temple bar", "harcourt street", "ranelagh", "rathmines", "south circular road"],
    ...dublinPages(["portobello", "the-coombe", "temple-bar", "rathmines", "ranelagh"], [2, 8]),
    collegeHousing: TUD_HOUSING,
  },
  "tud-bolton": {
    region: "dublin",
    localityHints: ["bolton street", "dublin 1", "dublin 7", "smithfield", "phibsborough", "stoneybatter", "north circular road", "dorset street", "parnell", "ifsc"],
    ...dublinPages(["smithfield", "phibsborough", "stoneybatter", "north-circular-road", "ifsc"], [1, 7]),
    collegeHousing: TUD_HOUSING,
  },
  "tud-tallaght": {
    region: "dublin",
    localityHints: ["tallaght", "dublin 24", "kilnamanagh", "firhouse", "templeogue", "oldbawn", "citywest", "jobstown", "knocklyon", "greenhills", "belgard", "kingswood"],
    ...dublinPages(["tallaght", "kilnamanagh", "firhouse", "oldbawn", "citywest", "knocklyon"], [24]),
    collegeHousing: TUD_HOUSING,
  },
  "tud-blanchardstown": {
    region: "dublin",
    localityHints: ["blanchardstown", "dublin 15", "castleknock", "clonsilla", "coolmine", "mulhuddart", "ongar", "tyrrelstown", "porterstown", "carpenterstown", "hartstown", "corduff"],
    ...dublinPages(["blanchardstown", "castleknock", "clonsilla", "coolmine", "mulhuddart", "ongar"], [15]),
    collegeHousing: TUD_HOUSING,
  },
  // Other colleges inside the region, at no extra cost to Daft (#27). Neither has a listing board of its own.
  rcsi: {
    region: "dublin",
    localityHints: ["dublin 2", "dublin 8", "portobello", "camden street", "harcourt street", "temple bar", "christchurch", "the coombe", "ranelagh", "rathmines", "south circular road"],
    ...dublinPages(["portobello", "temple-bar", "the-coombe", "ranelagh", "rathmines"], [2, 8]),
  },
  ncad: {
    region: "dublin",
    localityHints: ["thomas street", "the liberties", "dublin 8", "christchurch", "the coombe", "kilmainham", "rialto", "smithfield", "stoneybatter", "south circular road", "inchicore"],
    ...dublinPages(["christchurch", "the-coombe", "kilmainham", "rialto", "smithfield", "stoneybatter"], [8, 7]),
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
