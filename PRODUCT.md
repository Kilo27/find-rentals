# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user is the admin: a renter who studies or works at an Irish university campus (default: University of Limerick) and needs a home within reach of it. They are searching for themselves, under time pressure, and use the app mostly on an iPhone installed to the Home Screen (iOS 16.4+ for push).

Other users are people the admin chooses to invite, such as housemates, friends or family. They share the same search and the same listings, receive alerts on their own devices, and never see the Settings or Users tabs. Only the admin creates accounts. There is no public sign-up.

## Product Purpose

Rental Watch checks several Irish rental sources every 30 minutes for places near a campus and pushes a notification to each user's phone when a new match appears. The in-app Matches list (and its map) is where the user then decides whether a place is worth contacting.

Its most important quality is ease of use (the user's words: "otherwise what is the point"). The product exists to take effort out of the rental hunt, so anything that adds effort, for the admin or for an invited user, works against its purpose.

Success is that every alert is worth opening and the user reaches the landlord before other renters do, without having to trawl four sites. A false alert costs more than a missed one.

## Positioning

It answers "is there a place I can actually live near this campus" rather than "what is listed". Three things set it apart:

- It watches Daft.ie, UL Accommodation (Studentpad), Rent.ie, MyHome.ie and custom pages together, and merges the same property found on two sites into one alert with an "also on" link.
- It reads the National Transport Authority's timetables to keep homes just beyond the radius when a bus, tram or train goes direct to the campus from a stop within walking distance. The alert names the route, e.g. "304A 250 m away, 14 min to UL".
- It fails closed. When the data is uncertain it says so ("approx", "check distance", "check owner-occupied", "beyond 2 km · direct route") instead of guessing, and a scraper that breaks produces a visible warning, never wrong alerts.

## Operating Context

- The tool runs as one small Node service on Railway with a volume at `/data`, serving the phone web app and sending Web Push.
- Daft and Rent.ie refuse Railway's IP addresses, so those two sources are fetched by an agent on the admin's Windows laptop (`RentalWatchAgent`). While the laptop is asleep they are shown as "not checked", not as failed.
- Typical loop: a push arrives, the user opens the app, triages the card (price, distance, availability, flags, source, route to campus), marks it seen, "Not a fit" or "No longer available", then jumps to the source site to contact the landlord. Speed matters, because good places go fast.
- The admin tunes the search (centre, radius, sources, filters, transit rules) under Settings and monitors source health under Status. The admin can open the app "as" another user to debug why they aren't getting alerts.
- The map view (OpenStreetMap via Leaflet) is a secondary way to review matches: price pins, approximate-area shading, campus and radius, transit lines and stops.

## Capabilities and Constraints

- Matches have per-listing marks (Mark as seen, Not a fit, No longer available), stored on the server so they carry across scans and devices. A mark on one site's copy of a property covers all copies.
- Filters: distance (exact, with geocoding and cross-checks), owner-occupied, weekday-only lets, availability dates, price, beds, lease months, keywords.
- One shared search for all accounts. The centre point and radius are part of it, so only the admin can change settings. This is a deliberate current limit, not a permanent decision; see Product Principles.
- The admin account is defined by environment variables (`ADMIN_USERNAME`, `ACCESS_PASSWORD`), not stored in the app.
- The scrapers are honest about themselves (`RentalWatch/1.0`), honour `robots.txt`, rate-limit per host, and depend on third-party sites staying scrapeable. Map tiles are loaded from OpenStreetMap, so use must stay light.
- Terminology to keep: Matches, Mark as seen, Not a fit, No longer available, campus, centre (Irish/British spelling), direct route. Notification text states facts in short phrases (price, title, distance, source, route).
- Undecided: per-person searches, additional campuses per user, and self-serve sign-up. None are built.

## Brand Commitments

Existing name: **Rental Watch**, with the Home Screen label **Rentals**. App icons are in `public/icons/`. The user has not declared any visual identity binding.

## Evidence on Hand

- Real timetable-derived transit data for 30-plus Irish campuses in `src/transit/data.json`, built from NTA/Transport for Ireland GTFS feeds on 2026-10-01 (CC BY 4.0, attribution required wherever it is shown).
- Live listings from the configured sources, which are real content for any design work.
- There are no testimonials, user counts, usage metrics or public marketing copy. Future work must not invent any.

## Product Principles

1. **Ease of use comes first.** It is the product's most important feature, and when it conflicts with another principle, ease of use wins. A user, especially an invited one who didn't set anything up, should be able to get alerts and act on them without instructions, configuration or knowing how the scrapers work. Power, diagnostics and tuning stay out of the way until someone asks for them.
2. **Trust over volume.** An alert the user opens and regrets is worse than a missed one. Show what is known, what is approximate and what is unchecked, and never present a guess as a fact.
3. **Alert to decision in seconds.** The Matches card carries what the user needs to decide whether to contact the landlord. The source site is for acting, the app is for deciding.
4. **Small trusted group first.** Optimise for the admin and a few invited people sharing one search. Don't design out per-person searches, other campuses or wider reach later, and don't build for strangers now.
5. **The admin tunes, everyone else uses.** Settings, Users and diagnostics belong to the admin. Other users get a quiet, focused view of matches and their own devices.
6. **Say when the system is blind.** A skipped source, an offline laptop agent or a broken scraper is part of the product's state and should be visible, plain and unalarming, because the user is relying on the silence meaning "nothing new".
