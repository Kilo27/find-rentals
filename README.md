# Rental Watch

Watches several Irish rental sources every 30 minutes for places near a point (default: **University of Limerick, 2 km**) and sends a push notification to your iPhone when a new match appears. One small Node service runs on Railway and also serves the installable phone web app where you change every search setting.

## Sources

| Source | How | Notes |
|---|---|---|
| **Daft.ie** | Daft's gateway API (same as the open-source `daftlistings` client) | Real coordinates, server-side owner-occupied filter for rooms |
| **UL Accommodation** (accommodation.ul.ie, Studentpad) | Scrapes the all-adverts page, then each advert | UL's own noticeboard; many adverts are owner-occupied or weekday-only, which the filters catch |
| **Rent.ie** | Scrapes the Castletroy / University of Limerick search pages | Houses/apartments URLs are best guesses; a 404 is reported as "skipped" |
| **MyHome.ie** | Scrapes the Limerick rentals page (embedded JSON first, then HTML) | County-wide; the distance check trims it |
| **Custom pages** | Any listings page you add under Settings → Advanced | JSON-LD, embedded JSON or HTML cards |

The HTML scrapers are generic (JSON-LD → embedded page JSON → link "cards", with no dependence on CSS class names) and **fail closed**: a layout change produces zero results and a visible warning, never wrong alerts. They honour `robots.txt`, identify themselves, wait between requests to the same host, and only fetch detail pages for listings not already cached.

## How accuracy is kept

- **Distance** is checked exactly (straight line). Coordinates come from the source; if a listing has none, the address is geocoded via OpenStreetMap (cached, rate-limited, rejected if >40 km from the centre). Area-only geocodes are marked "approx". If nothing works the listing is only kept when its text names a nearby area, and is flagged "check distance".
- **Owner-occupied**: Daft's own filter for rooms, plus wording such as "owner-occupied", "live-in landlord", "sharing with the owner" in each listing's description. Negations ("not owner occupied", "landlord does not live in") are respected. Listings with no signal either way are flagged "check owner-occupied".
- **Weekday-only lets** ("Monday to Friday", "5-day rental", "Sunday evening to Friday morning") are excluded by default. These are common near UL and useless if you need the place full-time.
- **Availability**: start and end dates are read from listing text. A start date later than *need from* (default: today) plus a 14-day grace, or an end date more than 60 days before *stay until*, excludes the listing. Listings with no date are kept and flagged.
- **Duplicates**: the same property on two sites is alerted once, with an "also on" link. Different houses (e.g. 14 vs 16 Plassey Park), different prices and separate ads on one site are never merged.
- **No premature alerts**: listings still waiting for a detail page are held back rather than alerted half-checked.
- **Health**: a source that returns nothing usable 6 scans in a row sends a "looks broken" notification, and another when it recovers.

## Deploy on Railway

1. Railway: **New Project → Deploy from GitHub repo → `Kilo27/find-rentals`** (builds from the `Dockerfile`; choose your branch under Service → Settings → Source).
2. **Add a Volume** to the service, mount path `/data`. Without it, settings, the seen-list, caches and your phone's push registration are wiped on every deploy.
3. Service → **Variables**: `ACCESS_PASSWORD` (required), and optionally `VAPID_SUBJECT` (e.g. `mailto:you@example.com`).
4. Service → Settings → Networking → **Generate Domain**.

## Set up your iPhone

1. Open the Railway URL in **Safari** → Share → **Add to Home Screen**.
2. Open **Rental Watch from the Home Screen**, log in.
3. **Status → Enable notifications on this device → Allow**, then **Send test notification**. (Needs iOS 16.4+.)

## First thing to do after deploying: verify the scrapers

I built the HTML scrapers without network access to the live sites, so check them once on the real thing. In a Railway shell (or locally):

```bash
npm run probe                 # all sources
npm run probe -- ul rent      # specific sources
npm run probe -- --url=https://example-agent.ie/lettings/limerick   # try any page
```

It prints, per page, how many listings it recognised and for each: title, price, coordinates, availability, owner-occupied signal and whether the filters would pass it. If a source shows 0 listings it prints the start of the HTML it received, and **Status → Sources** plus `GET /api/debug` (while logged in) keep the same diagnostics for later scans.

## How it behaves

- First scan is a *baseline*: one "Watching started: N matches" notification, existing listings marked seen. If detail pages are still being fetched (limit per scan), the baseline waits until they are done.
- After that, each new match gets one notification showing price, title, distance, source and availability. More than 5 new in one scan: 5 individual pushes plus a digest. Tapping opens the listing.
- If every source fails 3 scans in a row you get a notification, and another on recovery.

## Settings (all editable in the app)

| Setting | Default |
|---|---|
| Centre / radius | University of Limerick (52.6733, -8.5739), 2 km |
| Sources | Daft.ie, UL Accommodation, Rent.ie, MyHome.ie |
| Exclude owner-occupied / weekday-only | on / on |
| Need from / stay until | immediately / 2027-06-30 |
| Start-date grace / end-date grace | 14 days / 60 days |
| Price, beds, lease months | off |
| Exclude / include keywords | owner-occupied wording / none |
| Listings with no coordinates | only if the area name matches (`castletroy`, `plassey`, `dromroe`, ...) |
| Geocode addresses, respect robots.txt | on / on |
| Scan interval | 30 min |
| Source page URLs, Daft location ID | see Advanced |

To search somewhere else: change the centre, radius, area names, the source page URLs and the Daft location ID (IDs are in the open-source [`daftlistings`](https://pypi.org/project/daftlistings/) package, `location.py`).

## Limitations

- Scraping depends on third-party sites staying scrape-able. Check each site's terms; Daft's gateway is unofficial. If Railway's IPs are blocked you will get a "looks broken" notification.
- Daft search results rarely include availability dates or descriptions, so Daft listings are not date-filtered and their owner-occupied check relies on Daft's own filter.
- Airbnb/Booking-style furnished monthly stays and Facebook groups are not covered (terms and login walls).
- Single user, single password.

## Local development

```bash
npm install
ALLOW_NO_AUTH=1 npm run dev        # or ACCESS_PASSWORD=secret npm start
npm test
```

Environment variables: see `.env.example`.
