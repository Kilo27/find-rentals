import { haversineKm } from "../geo.js";

// Universities and university-level colleges. A bus, tram or train "serves" a campus when one of its trips
// stops within reachM of the point (trams and trains get extra reach, see REACH_EXTRA_M, because people
// walk further from a station than from a bus stop). Big campuses get a bigger reachM.
// To add a campus: append it here and run `npm run transit` to rebuild src/transit/data.json.
export const CAMPUSES = [
  { id: "ul", name: "University of Limerick", short: "UL", region: "Limerick", lat: 52.6733, lng: -8.5739, reachM: 500 },
  { id: "mic", name: "Mary Immaculate College", short: "MIC", region: "Limerick", lat: 52.653, lng: -8.638, reachM: 450 },
  { id: "tus-limerick", name: "TUS Limerick (Moylish)", short: "TUS Limerick", region: "Limerick", lat: 52.6742, lng: -8.649, reachM: 450 },

  { id: "tcd", name: "Trinity College Dublin", short: "Trinity", region: "Dublin", lat: 53.344, lng: -6.2555, reachM: 500 },
  { id: "ucd", name: "University College Dublin (Belfield)", short: "UCD", region: "Dublin", lat: 53.3068, lng: -6.221, reachM: 700 },
  { id: "dcu-glasnevin", name: "DCU Glasnevin", short: "DCU", region: "Dublin", lat: 53.3862, lng: -6.2575, reachM: 450 },
  { id: "dcu-stpats", name: "DCU St Patrick's (Drumcondra)", short: "DCU St Pat’s", region: "Dublin", lat: 53.3715, lng: -6.2531, reachM: 400 },
  { id: "tud-grangegorman", name: "TU Dublin Grangegorman", short: "TU Dublin Grangegorman", region: "Dublin", lat: 53.3556, lng: -6.2823, reachM: 500 },
  { id: "tud-city", name: "TU Dublin Kevin Street / Aungier Street", short: "TU Dublin Kevin St", region: "Dublin", lat: 53.3385, lng: -6.2665, reachM: 450 },
  { id: "tud-bolton", name: "TU Dublin Bolton Street", short: "TU Dublin Bolton St", region: "Dublin", lat: 53.3517, lng: -6.2687, reachM: 400 },
  { id: "tud-tallaght", name: "TU Dublin Tallaght", short: "TU Dublin Tallaght", region: "Dublin", lat: 53.2897, lng: -6.3753, reachM: 450 },
  { id: "tud-blanchardstown", name: "TU Dublin Blanchardstown", short: "TU Dublin Blanchardstown", region: "Dublin", lat: 53.4036, lng: -6.3785, reachM: 450 },
  { id: "rcsi", name: "RCSI (St Stephen's Green)", short: "RCSI", region: "Dublin", lat: 53.3392, lng: -6.2627, reachM: 350 },
  { id: "ncad", name: "NCAD", short: "NCAD", region: "Dublin", lat: 53.3435, lng: -6.2786, reachM: 350 },
  { id: "maynooth", name: "Maynooth University", short: "Maynooth", region: "Dublin", lat: 53.3815, lng: -6.5935, reachM: 650 },

  { id: "ucc", name: "University College Cork", short: "UCC", region: "Cork", lat: 51.8935, lng: -8.4917, reachM: 600 },
  { id: "mtu-cork", name: "MTU Cork (Bishopstown)", short: "MTU Cork", region: "Cork", lat: 51.8837, lng: -8.533, reachM: 500 },

  { id: "uog", name: "University of Galway", short: "Univ. of Galway", region: "Galway", lat: 53.2785, lng: -9.0615, reachM: 600 },
  { id: "atu-galway", name: "ATU Galway City", short: "ATU Galway", region: "Galway", lat: 53.2777, lng: -9.0103, reachM: 450 },

  { id: "setu-waterford", name: "SETU Waterford (Cork Road)", short: "SETU Waterford", region: "Elsewhere", lat: 52.2463, lng: -7.1393, reachM: 450 },
  { id: "setu-waterford-college-st", name: "SETU Waterford (College Street)", short: "SETU College St", region: "Elsewhere", lat: 52.254, lng: -7.116, reachM: 400 },
  { id: "setu-carlow", name: "SETU Carlow", short: "SETU Carlow", region: "Elsewhere", lat: 52.83, lng: -6.936, reachM: 500 },

  { id: "tus-athlone", name: "TUS Athlone", short: "TUS Athlone", region: "Elsewhere", lat: 53.4157, lng: -7.9, reachM: 450 },
  { id: "atu-sligo", name: "ATU Sligo", short: "ATU Sligo", region: "Elsewhere", lat: 54.278, lng: -8.46, reachM: 500 },
  { id: "atu-letterkenny", name: "ATU Letterkenny", short: "ATU Letterkenny", region: "Elsewhere", lat: 54.9512, lng: -7.7208, reachM: 450 },
  { id: "atu-mayo", name: "ATU Mayo (Castlebar)", short: "ATU Mayo", region: "Elsewhere", lat: 53.8497, lng: -9.3051, reachM: 450 },
  { id: "dkit", name: "Dundalk IT", short: "DkIT", region: "Elsewhere", lat: 53.9833, lng: -6.3935, reachM: 450 },
  { id: "mtu-kerry", name: "MTU Kerry (Tralee)", short: "MTU Kerry", region: "Elsewhere", lat: 52.2714, lng: -9.6894, reachM: 450 },
];

// Trams and trains drop people at stations that are typically further from the gate than a bus stop.
export const REACH_EXTRA_M = { bus: 0, tram: 250, rail: 450 };

export const campusById = (id) => CAMPUSES.find((c) => c.id === id) ?? null;

// The campuses within km of a point.
export function campusesNear(lat, lng, km = 1) {
  return CAMPUSES.filter((c) => haversineKm(lat, lng, c.lat, c.lng) <= km).map((c) => c.id);
}

// Which campuses a search is about: the ones ticked in Settings, or, when none are, the campus at the search
// centre (those within a kilometre of it, else the nearest one within 5 km).
export function campusIdsFor(config) {
  const picked = (config.transitCampuses ?? []).filter((id) => campusById(id));
  if (picked.length) return picked;
  const { lat, lng } = config.center;
  const here = campusesNear(lat, lng, 1);
  if (here.length) return here;
  const [nearest] = CAMPUSES.map((c) => [haversineKm(lat, lng, c.lat, c.lng), c.id]).sort((a, b) => a[0] - b[0]);
  return nearest && nearest[0] <= 5 ? [nearest[1]] : [];
}
