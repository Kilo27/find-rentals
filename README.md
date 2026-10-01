# Rental Watch

Watches several Irish rental sources every 30 minutes for places near a point (default: **University of Limerick, 2 km**) and sends a push notification to your iPhone when a new match appears. One small Node service runs on Railway and also serves the installable phone web app where you change every search setting.

## Sources

| Source | How | Notes |
|---|---|---|
| **Daft.ie** | Daft's gateway API (same as the open-source `daftlistings` client) | Real coordinates, server-side owner-occupied filter for rooms. Daft may answer HTTP 403 to cloud hosts such as Railway; two header styles are tried and the Status tab shows the result |
| **UL Accommodation** (accommodation.ul.ie, Studentpad) | Reads the all-adverts list page only: address (the title), price, availability and landlord type are all on it | UL's own noticeboard. The individual advert pages are an empty JavaScript shell, so they are not fetched. Many adverts are "Resident Landlord/Host Family" or weekday-only, which the filters catch. Distance comes from geocoding the address |
| **Rent.ie** | Scrapes the search pages for the areas Rent.ie's own University of Limerick page lists as near-by: `houses-to-let` (houses and apartments) for Castletroy, Monaleen, Rhebogue, Newtown, Singland and Annacotty, and `rooms-to-rent` (shares) for Castletroy, Kilmurry, Kilbane, Monaleen, Rhebogue and Newtown | Checked live 2026-10-01. Rent.ie's student-accommodation pages carry no adverts, only links to these. Only each area's first page (its 20 newest adverts) is read, because its pagination links are disallowed by `robots.txt`. Answers HTTP 403 to any user agent claiming to be Chrome, and often to cloud hosts. Saved settings still holding the old default URLs are updated on start; a 404 is reported as "skipped" |
| **MyHome.ie** | Scrapes the Limerick rentals page for `/brochure/` links (embedded JSON first, then HTML) | The page is largely JavaScript-rendered, so it may find nothing; the Status tab says so. County-wide when it works; the distance check trims it |
| **Custom pages** | Any listings page you add under Settings → Advanced | JSON-LD, embedded JSON or HTML cards |

The HTML scrapers are generic (JSON-LD → embedded page JSON → link "cards", with no dependence on CSS class names) and **fail closed**: a layout change produces zero results and a visible warning, never wrong alerts. They honour `robots.txt`, identify themselves, wait between requests to the same host, and only fetch detail pages for listings not already cached.

## How accuracy is kept

- **Distance** is checked exactly (straight line). Coordinates come from the source where it has real ones. A coordinate that appears on many *different* listings is a site-wide map position, not a property, and is ignored (and remembered). Coordinates scraped from a page are cross-checked against the address, and the address wins if they disagree by more than 2 km. If a listing has no usable coordinates its address is geocoded via OpenStreetMap (cached, rate-limited, rejected if more than 40 km from the centre); area-only results are marked "approx". If nothing works the listing is only kept when its **address or title** (never the description, which says "close to UL" about places miles away) names a nearby area, and is flagged "check distance". Advert pages that are an empty loading shell contribute nothing.
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

## Reading the logs

Each scan writes one summary line to the service logs (Railway: service → Deployments → View logs), plus one line per problem page:

```
[scan] ok mode=normal 4120ms | daft=12 ul=8 rent=0! myhome=ERROR(HTTP 403 from www.myhome.ie) | candidates=20 rejected=14 pending=0 matches=6 new=1 notified=1
[scan] rent https://www.rent.ie/...: WARNING page loaded but no listings were recognised (layout change, bot wall or empty results)
```

`name=N` is how many listings that source returned, `!` means a page had a warning or error, and `ERROR(...)` means the whole source failed. Logs contain counts and source health only, never listing contents or the password.

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

## When a site blocks cloud hosts (proxy)

Daft and Rent.ie refuse requests from cloud providers' IP addresses (HTTP 403, or Daft's "Service Unavailable" page). **This was tested: a relay running in Railway's EU West (Amsterdam) region is refused too**, so moving regions or adding another cloud service does not help. The request has to leave from an ordinary (residential or ISP) IP address. Two ways, using the same setting:

1. **A paid residential/ISP proxy service.** Any HTTP(S) proxy URL works.
2. **A relay on your own home connection.** The same image can run as a minimal relay (`PROXY_MODE=1 PROXY_PASSWORD=<long random> PORT=3128 node src/server.js`) on a PC or Raspberry Pi at home. It only allows password-protected HTTPS tunnels (CONNECT) to `daft.ie` and `rent.ie` (`PROXY_ALLOW`), on port 443, never to private addresses. You must make it reachable from Railway (router port-forward or a tunnel). Plain HTTP to the relay exposes only its password, so use a long random one; the traffic to the sites inside the tunnel is HTTPS.

Then set on the app service:

```
SCRAPER_PROXY_URL=http://relay:<PROXY_PASSWORD>@<relay-host>:3128
SCRAPER_PROXY_SOURCES=daft,rent      # default; only these go through the proxy
```

Other sources and the geocoder stay direct. The scan log line ends with `via-proxy=daft,rent` when it is active. On start the relay logs `[relay] selftest daft ...` and `[relay] selftest rent.ie ...`, which tells you straight away whether its connection is let in.

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
