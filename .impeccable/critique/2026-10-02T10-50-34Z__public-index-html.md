---
target: the whole app (public/index.html)
total_score: 23
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-10-02T10-50-34Z
slug: public-index-html
---
Method: dual-agent (A: design-review sub-agent, B: detector/browser sub-agent). Static detector ran DEGRADED (HTML parser modules missing in the skill folder); in-page overlay scan ran fully.

# Critique: Rental Watch (whole app, public/index.html)

## Design Health Score: 23/40, Acceptable

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 2 | Matches never says the watcher is alive or a source is blind; notifications button not state-aware; raw "denied" |
| 2 | Match System / Real World | 2 | "laptop agent offline", "HTTP 403 (failing x4)", "41 / 6 / 1", "check owner-occupied" |
| 3 | User Control and Freedom | 3 | Reversible, View-as has Exit; Restore always sets "seen" (app.js:271) |
| 4 | Consistency and Standards | 3 | Consistent tokens; map sheet has "View listing", list card has no equivalent |
| 5 | Error Prevention | 2 | Two red buttons side by side; next card slides under thumb; invited users can Scan now |
| 6 | Recognition Rather Than Recall | 3 | Card link has no visible affordance; notifications under "Status" |
| 7 | Flexibility and Efficiency | 2 | No only-new filter, no mark-all-seen; push tap bypasses app |
| 8 | Aesthetic and Minimalist Design | 3 | List clean; map noisy (22 bus + 3 rail lines on by default); Settings/Status dense |
| 9 | Error Recovery | 2 | Raw source errors; boot network failure shows login |
| 10 | Help and Documentation | 1 | No help or onboarding; Add to Home Screen is one hint line on Status |

## Design Specificity Verdict
Content authored for the product (route line, honest flags, map copy); visual shell is category-interchangeable (teal-on-mint system-font utility, no brand mark). Proximity to campus is the product's one idea and the layout does not express it (distance is a muted 14px fragment, ui.js:88; transit time a 13px string, ui.js:56).
Detector: 1 CLI finding (border-accent-on-rounded, styles.css:158, false positive). Overlay: ai-color-palette (teal #2dd4bf as text on dark, 9 hits on list, contrast 7.6-9.2:1, one palette decision), flat-type-hierarchy (12/13/14/16/20/22, ~1.8:1, real). False positives: cramped-padding on .card, overused-font roboto (system stack), clipped-overflow-container on map, text-occlusion on collapsed map panel, gpt-thin-border-wide-shadow on hidden hovercard.

## What's Working
1. Honest card grammar (filled teal NEW, amber caution, teal outline transit, grey neutral; 20px bold price anchor).
2. Forgiving triage mechanics (44px actions, optimistic updates, dismissed items collapse, not lost).
3. Role clarity (View-as banner, invited tab bar, map touch sheet with View listing).

## Priority Issues
1. [P1] Getting alerts is never set up in the flow. Fix: first-run "Turn on alerts" card on Matches (iPhone Add to Home Screen steps), state-aware, plain denied steps, rename tab "Alerts", copyable invite message. Command: /impeccable onboard
2. [P1] Card has no visible primary action; two red dismissals are the loudest controls (~45% of card height). Fix: explicit "Open on Daft.ie" primary (marks seen), one neutral dismissal plus quieter More, distance/route next to price. Command: /impeccable layout
3. [P1] Silence is not trustworthy: raw source health, buried, shown to everyone. Fix: calm status strip on Matches, plain per-source sentences, admin-only Details. Scan now for any signed-in user is deliberate per README, so exposure is a user decision. Command: /impeccable clarify
4. [P2] Triage silent and mis-tap-prone; restore buried and lossy. Fix: 5s Undo bar, restore previous state, placeholder not reflow, Show hidden pill. Command: /impeccable harden
5. [P2] Boot/network failure looks like being logged out (app.js:74-80). Fix: skeleton, 401 vs network, offline copy, refetch on visibilitychange. Command: /impeccable harden

## Persona Red Flags
Casey: push tap opens source site not app (push.js:130, sw.js:24), never marked seen; 38px List/Map toggle; 60s re-render shifts content; stale on return.
Jordan: no statement of what the app does; jargon; "distance unverified" twice per card; ends-date flag unexplained; card tap leaves app silently.
Sam: 31 Settings fields unlabelled; placeholder-only login/Users inputs; no aria-current; no aria-live on messages; seen cards ~2.4:1; no focus trap on map sheet.
Aoife (invited housemate): list with no mention of alerts in Safari; shared "Not a fit" hides admin's pick silently; sees Scan now and HTTP 403; admin cannot preview her setup.

## Minor Observations
Matches count includes seen cards; "listed 3 h ago" is last pill; stretched pills; "also on" not a link; Settings order (lat/lng before campus picker, Save 3.7 screens down); Users password shown once, no Copy, native confirm/prompt; View-as map banner height not subtracted (styles.css:124); manifest background_color dark flash; pre-existing console error "unknown error fetching the script" (possibly SW registration, unverified).

## Questions to Consider
Should "turn on alerts" be first? Should a push tap open the app card with a big Open-on-source button and auto-seen? Do three equal buttons belong on every card? Do invited users need a Status tab? Is shared "Not a fit" a feature or a hazard?
