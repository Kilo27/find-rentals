# Rental Watch

Watches Daft.ie every 30 minutes for rentals near a point (default: **University of Limerick, 2 km**) and sends a push notification to your iPhone the moment a new match appears. It is one small Node service that runs on Railway and also serves the installable phone web app where you change every search setting.

- Searches three Daft sections: houses/apartments, rooms to rent/share, student accommodation
- Excludes owner-occupied listings (Daft's own filter for room listings, plus keyword checks)
- Exact straight-line distance check (Daft only offers 1/3/5/10/20 km shapes)
- Real Web Push (works on iPhone once the site is on your Home Screen, iOS 16.4+)
- Every parameter is editable from the **Settings** tab; no redeploy needed

## Deploy on Railway

1. Railway: **New Project → Deploy from GitHub repo → `Kilo27/find-rentals`**. It builds from the `Dockerfile`. Deploy the branch you want under Service → Settings → Source.
2. **Add a Volume** to the service, mount path `/data`. Without it, settings, the "already seen" list and your phone's push registration are wiped on every deploy. (`DATA_DIR` defaults to the volume mount automatically.)
3. Service → **Variables**:
   - `ACCESS_PASSWORD` (required): the password you type once per device
   - `VAPID_SUBJECT` (optional): e.g. `mailto:you@example.com`; defaults to your Railway domain
4. Service → Settings → Networking → **Generate Domain**. You need the HTTPS URL.

The first scan runs ~10 seconds after boot and repeats every 30 minutes (adjustable in Settings).

## Set up your iPhone

1. Open the Railway URL in **Safari**.
2. Share → **Add to Home Screen**.
3. Open **Rental Watch from the Home Screen** (not Safari). Log in.
4. **Status → Enable notifications on this device → Allow**, then **Send test notification**.

iOS only delivers web push to Home Screen apps, so step 3 matters. Storage is separate between Safari and the Home Screen app, so you log in again there.

## How it behaves

- The very first successful scan is a *baseline*: one "Watching started: N current matches" notification, and existing listings are marked seen so you are not spammed.
- After that, each new matching listing gets one notification (price, title, distance). More than 5 new in one scan: 5 individual pushes plus a digest. Tapping a notification opens the Daft listing.
- If Daft scans fail 3 times in a row you get a "can't reach Daft" notification, and another when it recovers. The Status tab shows the last error.
- If a notification can't be delivered to any device, the listing is retried on the next scan.

## Settings (all editable in the app)

| Setting | Default |
|---|---|
| Centre / radius | University of Limerick (52.6733, -8.5739), 2 km |
| Sections | houses & apartments, rooms, student accommodation |
| Exclude owner-occupied | on |
| Price / beds | off |
| Need from / stay until | immediately / 2027-06-30 |
| Lease min/max months | off |
| Exclude keywords | owner occupied, owner-occupied, live-in landlord, landlord lives |
| Include keywords | none |
| Scan interval | 30 min |
| Daft location ID (advanced) | 4342 (University of Limerick) |

To search somewhere else: change the centre coordinates, radius and the Daft location ID. IDs are listed in the open-source [`daftlistings`](https://pypi.org/project/daftlistings/) package (`location.py`).

## Limitations worth knowing

- **Availability dates are not filterable.** Daft's search results rarely include an "available from" date or lease end. "Stay until" and the short-term wording check (`short term`, `until June`, `academic year`, ...) only *flag* listings as "short-term friendly". Lease min/max only filters listings that state a lease length.
- **Owner-occupied detection** uses Daft's server-side filter on room sections and a keyword check on the title/text returned by search. Listings without the flag show a "check owner-occupied" badge.
- **Daft can change or block its gateway API.** This uses the same unofficial endpoint as the open-source `daftlistings` client. Check Daft's terms before relying on it. If Railway's IPs get blocked you will get the failure notification, and `GET /api/debug` (logged in) shows the raw response sample.
- Single user, single password. Not designed to be multi-tenant.

## Local development

```bash
npm install
ALLOW_NO_AUTH=1 npm run dev     # or ACCESS_PASSWORD=secret npm start
npm test
npm run icons                   # regenerate PNG icons
```

Environment variables: see `.env.example`. `DAFT_API_URL` lets you point the scraper at a mock gateway for testing.
