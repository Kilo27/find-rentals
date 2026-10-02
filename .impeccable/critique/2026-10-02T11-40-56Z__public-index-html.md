---
target: the whole app (public/index.html), run 2
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
timestamp: 2026-10-02T11-40-56Z
slug: public-index-html
---
Method: dual-agent (A: design-review sub-agent, B: detector/browser sub-agent). Static detector ran DEGRADED (HTML parser modules missing in the skill folder); in-page overlay scan ran fully. Second run for this target; follows the changes in PR 42.

# Critique: Rental Watch (whole app, public/index.html), run 2

## Design Health Score: 28/40, Good (previous run: 23/40)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Strip, offline banner, Undo toast good; routine pause uses the same amber triangle as a fault; Restore gives no feedback |
| 2 | Match System / Real World | 3 | Jargon in Settings and in pushes to everyone ("npm run agent", "HTTP 403") |
| 3 | User Control and Freedom | 3 | Unsaved Settings edits lost on tab switch; exiting View-as lands on Alerts |
| 4 | Consistency and Standards | 3 | "Open on Daft.ie" vs "View listing" on map sheet; More is broken |
| 5 | Error Prevention | 2 | Shared verdicts unannounced; lat/lng typed by hand |
| 6 | Recognition Rather Than Recall | 3 | iPhone steps say "tap Share" with no glyph; dismissed section buried at the bottom |
| 7 | Flexibility and Efficiency | 3 | Focus resets to the page after every action |
| 8 | Aesthetic and Minimalist Design | 3 | A transit fact stated three ways on a card; map defaults to ~25 loud lines |
| 9 | Error Recovery | 3 | Raw HTTP codes in admin panel and pushes |
| 10 | Help and Documentation | 2 | Nothing explains "area only" or "~"; no help path for an invitee |

## Design Specificity Verdict
Interaction model authored for the product; visual skin interchangeable (teal-tinted neutrals, system font, rounded white cards, no mark or logo).
Detector: CLI 1 finding (border-accent-on-rounded, styles.css:178, false positive: map legend line sample). Overlay: 25 on Matches, 24 of them ai-color-palette (teal accent #2dd4bf, triple-counted per button: link, svg, path; contrast 6.4-9:1). Advisory: flat type / monotonous spacing. False positives: clipped-overflow-container (Leaflet), hidden hovercard shadow, roboto (system stack). The detector cannot see any functional defect.

## What's Working
1. One dominant action per card (Open on {site}, marks seen).
2. Honest, calm trust language (outlined amber for uncertainty; icon plus words for status).
3. Forgiving dismissal and landing (Undo, Restore, mis-tap guard, alert tap lands on the card).

## Priority Issues
1. [P0] More is broken (regression): h() flattens one level, so nested buttons render as "[object HTMLButtonElement]". Fix: deep flatten plus test. Command: harden
2. [P1] Alert tap while app open can show a false "no longer in your matches": openListing checks stale state; target dropped if signed out. Fix: refresh and retry, keep target across login. Command: harden
3. [P1] Admin-only operational pushes go to every user in developer language (scan.js sendToAll). Fix: admin devices only. Command: clarify
4. [P1] Status strip alarms on routine states (laptop asleep = amber triangle). Fix: tiered levels, neutral for routine, no site names for invitees. Command: clarify
5. [P1] Accessibility: focus lost after every action; 31 Settings labels unassociated; repeated unnamed card buttons; input borders 1.2:1; active tab by colour only. Command: audit then harden

## Persona Red Flags
Casey: false toast after a push; More garbage; Restore gives no feedback; cold launch offline shows browser error (no SW caching); 38px Scanner details.
Jordan: no Share glyph; no warning about second login; "Not now" hides the alerts card forever; no proof alerts work.
Sam: focus lost; unlabelled fields; tab active by colour only; 1.2:1 borders.
Aoife (invited housemate): WhatsApp in-app browser not warned about; receives ops pushes; her Not a fit silently hides a place for everyone.

## Minor Observations
Restore no feedback; direct-route chip duplicates lead line; map sheet label inconsistent; View-as exit lands on Alerts; cryptic Scanner labels; login button auto-width and faint input borders; "also on" chip is plain text.

## Questions to Consider
One-time invite link that signs in the Home Screen app? Household vs personal "Not a fit"? Does the map earn its place in triage?
