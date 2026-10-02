---
target: the whole app (public/index.html), run 3
total_score: 28
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
timestamp: 2026-10-02T12-08-37Z
slug: public-index-html
---
Method: dual-agent (A: design-review + functional-sweep sub-agent, B: detector/browser sub-agent). Static detector ran DEGRADED (HTML parser modules missing in the skill folder); in-page overlay scan ran fully. Third run for this target; a regression check after PRs 43 and 44.

# Critique: Rental Watch (whole app, public/index.html), run 3

## Design Health Score: 28/40, Good (runs: 23 -> 28 -> 28)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | "Not now" removes the only cue that alerts are off; marks are global but nothing says so |
| 2 | Match System / Real World | 3 | "Scanner details", "Found / matching / new", lat/long fields |
| 3 | User Control and Freedom | 3 | Unsaved Settings lost on tab change; Undo toast not reachable by keyboard in time |
| 4 | Consistency and Standards | 3 | Map does not mark seen; native prompt()/confirm() in Users |
| 5 | Error Prevention | 3 | Another person's "Not a fit" silently hides a listing for everyone |
| 6 | Recognition Rather Than Recall | 3 | Two real actions under More; badge meanings never explained |
| 7 | Flexibility and Efficiency | 2 | No filter/sort/gestures |
| 8 | Aesthetic and Minimalist Design | 3 | Three blocks above the first card when alerts are off; map overlay overpowers pins |
| 9 | Error Recovery | 3 | A server error at start-up looks like being signed out (D5) |
| 10 | Help and Documentation | 2 | No legend for "approx" / "area only"; no how-it-works |

## Functional sweep (A): no P0, no stray "[object"/undefined/null/NaN, no console errors from app code in any state.
Defects: D1 focus lost after Mark as seen/unseen [P2]; D2 map pins keyboard activation [P2, to verify: popup blocked in the pane]; D3 focus after route row toggle [P3]; D4 focus drops after Restore of last card, Done, Exit, Not now, Scanner details, See them in the list [P3]; D5 server error at start-up shows the login screen [P1]; D6 aria-label "Fewer options" vs visible "Less" [P3]; D7 Scanner details link lands at top of Alerts [P3]; D8 Settings checkbox shrinks, paired labels misalign [P3]; D9 "Next scan in 278 h" [P3]; D10 dangling <label>Campuses</label> [P3]; D11 opening from the map does not mark seen [P3].

## Design Specificity Verdict
Information design is strongly product-specific; visual identity is generic (system font, one teal accent, no brand mark). Acceptable for a private tool. Detector: 1 CLI finding (border-accent-on-rounded, false positive); overlay 25 on Matches, 24 of them the single teal-accent hue flag (triple counted); no app console errors or unhandled rejections.

## Priority Issues
1. [P1] Login-to-alerts path is the weakest, and "Not now" erases the cue. Fix: persistent one-line cue; numbered invite; Share glyph. Command: clarify, harden
2. [P1] Marks are global but read as personal (product decision). Command: shape, clarify
3. [P1] A server error at start-up looks like being signed out (D5). Command: harden
4. [P2] Keyboard and screen-reader gaps in repeated controls (D1-D4, D6, D2). Command: harden
5. [P2] Settings is a developer form (73 inputs, no sticky Save). Command: distill, polish

## Minor Observations
Map default overlay outshouts pins; emoji mixed with SVG icons; manifest background dark in light mode; iOS status bar black-translucent over light page (unverified); reset password uses native prompt; invite is iPhone-only.

## Questions to Consider
Does an invited person need a username and password at all (invite code on first launch)? "Not a fit" is taste, "No longer available" is fact: why both global? Should an alert arrival be a one-card decision screen?
