# Rental Watch

Watches several Irish rental sources every 30 minutes for places near a point (default: **University of Limerick, 2 km**) and sends a push notification to your iPhone when a new match appears. One small Node service runs on Railway and also serves the installable phone web app where you change every search setting.

## Sources

| Source | How | Notes |
|---|---|---|
| **Daft.ie** | Daft's own search pages, which carry their results as page data (the same listing data as Daft's gateway API) | Real coordinates, server-side owner-occupied filter for rooms. Daft's gateway API refuses every client that isn't a browser, so it is no longer used. An area name Daft doesn't know is reported as an error rather than searching all of Ireland |
| **UL Accommodation** (accommodation.ul.ie, Studentpad) | Reads the all-adverts list page only: address (the title), price, availability and landlord type are all on it | UL's own noticeboard. The individual advert pages are an empty JavaScript shell, so they are not fetched. Many adverts are "Resident Landlord/Host Family" or weekday-only, which the filters catch. Distance comes from geocoding the address |
| **Rent.ie** | Scrapes the search pages for the areas Rent.ie's own University of Limerick page lists as near-by: `houses-to-let` (houses and apartments) for Castletroy, Monaleen, Rhebogue, Newtown, Singland and Annacotty, and `rooms-to-rent` (shares) for Castletroy, Kilmurry, Kilbane, Monaleen, Rhebogue and Newtown | Checked live 2026-10-01. Rent.ie's student-accommodation pages carry no adverts, only links to these. Only each area's first page (its 20 newest adverts) is read, because its pagination links are disallowed by `robots.txt`. Saved settings still holding the old default URLs are updated on start; a 404 is reported as "skipped" |
| **MyHome.ie** | Scrapes the Limerick rentals page for `/brochure/` links (embedded JSON first, then HTML) | The page is largely JavaScript-rendered, so it may find nothing; the Status tab says so. County-wide when it works; the distance check trims it |
| **Custom pages** | Any listings page you add under Settings → Advanced | JSON-LD, embedded JSON or HTML cards |

The HTML scrapers are generic (JSON-LD → embedded page JSON → link "cards", with no dependence on CSS class names) and **fail closed**: a layout change produces zero results and a visible warning, never wrong alerts. They honour `robots.txt`, identify themselves, wait between requests to the same host, and only fetch detail pages for listings not already cached. They identify themselves honestly as `RentalWatch/1.0`: a user agent that pretends to be Chrome is refused by Cloudflare (Daft, Rent.ie) with a "Security Check" page from any network.

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
3. Service → **Variables**: `ACCESS_PASSWORD` (required, the admin's password), and optionally `ADMIN_USERNAME` (default `admin`) and `VAPID_SUBJECT` (e.g. `mailto:you@example.com`).
4. Service → Settings → Networking → **Generate Domain**.

## Set up your iPhone

1. Open the Railway URL in **Safari** → Share → **Add to Home Screen**.
2. Open **Rental Watch from the Home Screen**, log in with your username and password.
3. **Status → Enable notifications on this device → Allow**, then **Send test notification**. (Needs iOS 16.4+.)

## Accounts

There is one **admin** account, and only the admin can create others. The admin is not stored in the app: its username is `ADMIN_USERNAME` (default `admin`) and its password is `ACCESS_PASSWORD`, so it can't be created, changed or removed from inside the app, and you can always get back in by changing the variable. Changing `ACCESS_PASSWORD` signs the admin out of every device.

The admin gets a **Users** tab:

- **Add a user**: pick a username and a password (or press Generate) and give them both. They can change their own password under **Status**.
- **View as**: opens the app exactly as that user sees it (their devices, no Users tab), with a banner and an **Exit** button. While viewing as someone you can't change their devices or password, and it doesn't count as them being active. Signing in again ends it.
- **Send test**, **Reset password** and **Remove**. Resetting a password or removing a user signs them out everywhere at once; removing a user also deletes their devices, so they stop getting alerts.
- Each user's last sign-in, last activity and subscribed devices (including push errors) are listed, for working out why someone isn't getting alerts.

Everyone shares **one search**: the same listings, the same settings and the same scan, and the centre point (campus) and radius are part of it. So only the admin can change the search settings (the Settings tab is admin-only); otherwise one person's change would replace everyone's. Each person gets the alerts on their own devices, and "Send test notification" only reaches your own. Any signed-in user can press Scan now, and only the admin can open `GET /api/debug`. Separate searches per person (for example different campuses) aren't supported yet. Sign-ins use a per-user password (stored hashed) and are limited to 10 failed attempts per IP per 15 minutes.

Upgrading from the single-password version: sign in once more on each device, with the old `ACCESS_PASSWORD` and username `admin` (or your `ADMIN_USERNAME`). Devices already registered for notifications become the admin's.

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
- Each listing in the Matches tab has **Mark as seen** (dims it, tap again to undo), **Not a fit** and **No longer available**. The last two move it to a collapsed list of the same name at the bottom, where **Restore** / **Still available** brings it back. These marks are stored on the server with the rest of the state, so they carry across scans and devices, and when the same property is on several sites a mark on one copy covers them all.
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
| Source page URLs, Daft area | see Advanced |

To search somewhere else: change the centre, radius, area names, the source page URLs and the Daft area (the name in a Daft search URL, e.g. `castletroy-limerick` from `daft.ie/sharing/castletroy-limerick`).

## When a site blocks cloud hosts (laptop agent or proxy)

Daft and Rent.ie sit behind Cloudflare. Two causes of HTTP 403 that had nothing to do with the server's address are fixed: Daft's gateway API (which refuses every non-browser client, home connections included) is no longer used, and the scrapers no longer send a user agent that claims to be Chrome. If a source still shows `ERROR(HTTP 403 ...)` in the scan log, the site is refusing the server's IP address, as Daft and Rent.ie do with Railway's. The error line shows the start of the refusal page, and "Security Check" there is Cloudflare. Moving regions or another cloud provider is unlikely to help; the request has to leave from an ordinary (residential or ISP) connection. There are two ways to do that. Either way only the sources in `SCRAPER_PROXY_SOURCES` (default `daft,rent`) use it; the other sources and the geocoder stay direct.

### A computer at home (laptop agent)

A small agent runs on a computer at home and connects *out* to the app over HTTPS, so there is nothing to open on your router and no tunnel service. The app hands it the Daft and Rent.ie page requests; it fetches them from your home connection and sends the pages back.

1. Make a long random token: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`
2. Railway → service → **Variables**: `AGENT_TOKEN=<token>`.
3. On the home computer, in a clone of this repo (after `npm install`), create `.env`:
   ```
   AGENT_SERVER_URL=https://<your-app>.up.railway.app
   AGENT_TOKEN=<the same token>
   ```
4. Run `npm run agent` to try it; it logs every page it fetches. To start it automatically and hidden whenever you log in to Windows, logging to `agent.log`: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-agent-task.ps1` (remove with `Unregister-ScheduledTask -TaskName RentalWatchAgent`).

The agent only makes HTTPS requests to `daft.ie` and `rent.ie` (`AGENT_ALLOW`). It re-checks every redirect, never connects to private (home network) addresses and is never sent cookies, so the server can't use it for anything else. The scan log line ends with `via-laptop=daft,rent` while it is in use.

While the computer is asleep or off, Daft and Rent.ie are skipped rather than failed: the log shows `daft=skipped ... | laptop=offline`, the Status tab says "not checked", they don't count towards "looks broken" alerts, and their earlier matches stay in the app. When the agent reconnects after a missed scan, a scan runs straight away. If it has been gone for a day you get one notification, and another when it is back.

### A paid residential proxy

Any HTTP(S) proxy URL works, for example a pay-as-you-go residential proxy. Daft and Rent.ie use roughly 1–2 GB a month at the default 30-minute interval.

```
SCRAPER_PROXY_URL=http://<user>:<password>@<proxy-host>:<port>
```

It takes precedence over the laptop agent, so switching is just setting this variable (and stopping the agent). The scan log line ends with `via-proxy=daft,rent`.

## Limitations

- Scraping depends on third-party sites staying scrape-able. Check each site's terms; Daft's search pages are not an API and can change (the Daft source then reports "no listing data" rather than guessing). If Railway's IPs are blocked you will get a "looks broken" notification.
- Daft search results rarely include availability dates or descriptions, so Daft listings are not date-filtered and their owner-occupied check relies on Daft's own filter.
- Airbnb/Booking-style furnished monthly stays and Facebook groups are not covered (terms and login walls).
- One shared search for all accounts; per-person search settings aren't supported.

## Local development

```bash
npm install
ALLOW_NO_AUTH=1 npm run dev        # sign in as `admin` with an empty password; or ACCESS_PASSWORD=secret npm start
npm test
```

Environment variables: see `.env.example`.
