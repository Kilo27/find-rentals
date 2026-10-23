---
name: ASAP accommodation
description: A To Let column of your own, set in ink on newsprint and marked up like the paper.
colors:
  paper: "#f0efea"
  sheet: "#fbfbf8"
  ink: "#141414"
  ink-2: "#45453f"
  muted: "#5f5f58"
  rule: "#cfcec6"
  field: "#77766e"
  hl: "#f7e933"
  hl-ink: "#141414"
  pen: "#2340b8"
  err: "#c0251b"
  on-ink: "#f0efea"
  band: "#141414"
  paper-night: "#121211"
  sheet-night: "#1b1b19"
  ink-night: "#ecebe5"
  ink-2-night: "#c4c3bb"
  muted-night: "#a4a39b"
  rule-night: "#3b3b37"
  field-night: "#8a897f"
  hl-night: "#f2e22c"
  pen-night: "#9db0ff"
  err-night: "#ff8a7f"
  on-ink-night: "#121211"
  band-night: "#000000"
typography:
  display:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "36px"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "-0.005em"
    fontVariation: '"wdth" 62'
  headline:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "34px"
    fontWeight: 900
    lineHeight: 0.9
    letterSpacing: "normal"
    fontVariation: '"wdth" 62'
  headline-question:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "40px"
    fontWeight: 900
    lineHeight: 0.98
    letterSpacing: "-0.005em"
    fontVariation: '"wdth" 64'
  title:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "24px"
    fontWeight: 900
    lineHeight: 1
    letterSpacing: "0.005em"
    fontVariation: '"wdth" 66'
  price:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "34px"
    fontWeight: 850
    lineHeight: 0.95
    letterSpacing: "-0.01em"
    fontFeature: '"tnum" 1, "lnum" 1'
    fontVariation: '"wdth" 68'
  distance:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "23px"
    fontWeight: 800
    lineHeight: 1
    fontFeature: '"tnum" 1'
    fontVariation: '"wdth" 72'
  choice:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "20px"
    fontWeight: 800
    lineHeight: 1.15
    fontVariation: '"wdth" 76'
  ad-title:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.3
    fontVariation: '"wdth" 100'
  body:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.45
    fontVariation: '"wdth" 100'
  body-small:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
    fontVariation: '"wdth" 100'
  subhead:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "14px"
    fontWeight: 850
    letterSpacing: "0.06em"
    fontVariation: '"wdth" 80'
  action:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "14px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.06em"
    fontVariation: '"wdth" 80'
  label:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "12.5px"
    fontWeight: 700
    letterSpacing: "0.05em"
    fontFeature: '"tnum" 1'
    fontVariation: '"wdth" 85'
  badge:
    fontFamily: 'Archivo, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif'
    fontSize: "12.5px"
    fontWeight: 750
    lineHeight: 1.35
    letterSpacing: "0.05em"
    fontVariation: '"wdth" 80'
rounded:
  none: "0px"
  sm: "2px"
  full: "50%"
spacing:
  gutter: "16px"
  ad-gap: "16px"
  section-gap: "24px"
  box-inset: "14px"
  row-pad: "9px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    padding: "11px 18px"
    height: "46px"
  button-primary-wide:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    height: "54px"
    width: "100%"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    padding: "11px 18px"
    height: "46px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "{colors.err}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    padding: "11px 18px"
    height: "46px"
  button-link:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    height: "44px"
  ad-display:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 14px 13px"
  ad-line:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "10px 12px 11px"
  ad-open-bar:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    typography: "{typography.action}"
    rounded: "{rounded.none}"
    height: "52px"
  ad-action:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.none}"
    padding: "10px 8px"
    height: "46px"
  badge:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  badge-new:
    backgroundColor: "{colors.hl}"
    textColor: "{colors.hl-ink}"
    typography: "{typography.badge}"
    rounded: "{rounded.none}"
    padding: "2px 6px"
  badge-seen:
    backgroundColor: "transparent"
    textColor: "{colors.pen}"
    typography: "{typography.badge}"
    rounded: "{rounded.none}"
  input:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.sm}"
    padding: "10px 12px"
    height: "46px"
  segmented:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.action}"
    rounded: "{rounded.sm}"
    padding: "0 16px"
    height: "44px"
  segmented-active:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  nav-tabs:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.muted}"
    height: "60px"
  nav-tab-active:
    textColor: "{colors.ink}"
  notice:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "10px 14px 12px"
  choice:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    typography: "{typography.choice}"
    rounded: "{rounded.sm}"
    padding: "13px 16px"
    height: "60px"
  choice-chosen:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  pill:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 16px"
    height: "46px"
  pill-chosen:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-ink}"
    rounded: "{rounded.sm}"
    padding: "4px 6px 4px 16px"
  viewing-banner:
    backgroundColor: "{colors.hl}"
    textColor: "{colors.hl-ink}"
    padding: "6px 16px"
  map-pin:
    backgroundColor: "{colors.sheet}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "3px 7px"
  map-pin-new:
    backgroundColor: "{colors.hl}"
    textColor: "{colors.hl-ink}"
    rounded: "{rounded.none}"
    padding: "3px 7px"
---

# Design System: ASAP accommodation

## Overview

**Creative North Star: "The Classifieds"**

ASAP accommodation is your own To Let column, reprinted every 30 minutes, that you mark up the way you would mark up the paper. The page is newsprint, the type is black ink, and the column is held together by rules rather than by cards: a heavy rule opens every section, a box of ink holds every ad, and hairlines divide the rows inside a box. Archivo, set heavy and condensed, does the work of headlines, prices and marks; at full width it is the reading text.

Colour is not decoration here. It lives only in the listing photos, the map, and two marks a reader makes with their own hand: the yellow highlighter, which means new, and the blue ballpoint, which means yours (circled, ticked, struck out, focused). One red pen is kept for correction. Everything else is ink on paper, so the eye goes straight to the price, the distance, and whatever has been marked. Line style carries certainty: a solid line is something known, a dashed one is approximate or unchecked. Dark mode is a night edition: ink and paper trade places and the marks stay marks.

The system is dense in the way a classifieds page is dense: a phone-width column of ads, each judged on one line (price left, distance right), with the way on in a bar of ink underneath. It refuses the property-portal card stack: rounded white cards, brand-colour buttons and a system font.

**Key Characteristics:**
- Newsprint ground (paper), a shade-brighter stock for boxes (sheet), black ink for type, rules and actions.
- Two marks only: highlighter yellow for new, ballpoint blue for your own marks and keyboard focus; a red pen for errors and Remove.
- One variable family, Archivo, whose width axis (62% to 100%) is the hierarchy.
- Square-cut boxes; controls just off the knife (2px); round only for the campus mark and the waiting dot.
- Solid means known, dashed means approximate or unchecked, dotted means not being checked right now.
- Flat paper: depth is ruled, not shadowed; only things that float over the page cast a shadow.

## Colors

Ink on newsprint, with exactly two marks and one red pen.

### Primary
- **Highlighter Yellow** (#f7e933; night #f2e22c): what is new, and only the things you would go over with a highlighter. It sits behind the price of a new ad as a hand-drawn band, fills the NEW badge and a new map pin, goes over "ASAP" in the masthead, the Home Screen icon and a text selection, marks the selected route in the map key, and fills the "Viewing as" banner the admin cannot miss. Type on it is always **Ink on Highlighter** (#141414), in both editions.

### Secondary
- **Ballpoint Blue** (#2340b8; night #9db0ff): the reader's own marks. The ring drawn round an alert's price, the tick on a seen ad, the strike-out across a put-away one, the "Restore" or "Still available" that undoes it, the campus outline and star on the map, the text caret, the waiting dot in setup, and the one keyboard focus ring.

### Tertiary
- **Red Correction Pen** (#c0251b; night #ff8a7f): the one colour beyond the two marks, kept so a failure can be told apart at a glance. It is used only for error messages ("Couldn't save that") and the destructive Remove button (red text and border on a transparent button).

### Neutral
- **Newsprint** (#f0efea; night #121211): the page itself, the tab bar, the save bar.
- **Boxed-Ad Stock** (#fbfbf8; night #1b1b19): the same stock a shade brighter, for anything boxed: ads, notices, fields, choices, map panels, the bottom sheet.
- **Press Black** (#141414; night #ecebe5): all primary type, every structural rule and box edge, and the fill of every primary action.
- **Worn Ink** (#45453f; night #c4c3bb): secondary text, meta lines, hints, a seen ad's price (9:1 on paper).
- **Faded Ink** (#5f5f58; night #a4a39b): quiet text, placeholders, inactive tabs (5.5:1 on paper).
- **Hairline Grey** (#cfcec6; night #3b3b37): hairlines inside a box, the gaps between an ad's actions, image and map placeholders, the empty progress track.
- **Field Edge** (#77766e; night #8a897f): the edge of an input, darker than a hairline so a field can be found (3:1 against the page).
- **Reversed-Out Paper** (#f0efea; night #121211): type reversed out of an ink fill (primary buttons, the Open bar, the active List/Map tab, the toast).
- **Status-Bar Band** (#141414; night #000000): the strip of ink behind the phone's status bar, like the rule along the top of a page; also the browser theme colour.

### The Night Edition
Under `prefers-color-scheme: dark`, ink and paper trade places and every neutral inverts with them. The marks stay marks: the highlighter barely moves and keeps black ink on it (the highlighted price and "ASAP" stay black in the dark), the pen lightens to #9db0ff and the red pen to #ff8a7f to hold contrast on the dark page. Map tiles are inverted greyscale at night.

### Named Rules
**The Two Marks Rule.** Colour lives only in the photos, the map and the two marks. Yellow means new; blue means yours. No other hue enters the paper, except the red pen.

**The Red Pen Rule.** Red is for correction only: an error message or the destructive Remove button. Never a warning, never a badge, never emphasis.

**The Ink Acts Rule.** The way on is always ink. Primary buttons and an ad's Open bar are filled with Press Black and reversed out; a mark colour never fills a call to action.

## Typography

**Display Font:** Archivo (with system-ui, -apple-system, Segoe UI, Roboto, sans-serif)
**Body Font:** Archivo (with system-ui, -apple-system, Segoe UI, Roboto, sans-serif)

**Character:** One family doing the work of two. Archivo variable (weight 100–900, width axis) is self-hosted at `/vendor/archivo` and its Latin file is preloaded. Condensed to 62–68% and set at 850–900 it is a newspaper's display face for the name, column heads and prices; at 72–85% it sets figures, labels and buttons in tight capitals; at 100% it is plain reading text. Width is a hierarchy axis: the font file allows up to 125%, the system never goes past 100%.

### Hierarchy
- **Display** (900, 36px, 0.95, wdth 62): the masthead name only. 64px on the sign-in screen, 28px in the setup's top bar. "accommodation" sits beside it at 750, 0.78em, wdth 72.
- **Headline** (900, 34px, 0.9, wdth 62, uppercase): the column head, "TO LET".
- **Headline, question** (900, 40px, 0.98, wdth 64, uppercase): one question per screen in the guided setup.
- **Title** (900, 24px, 1, wdth 66, uppercase): section heads and the summaries of collapsible sections (27px in a box that asks for something).
- **Price** (850, 34px, 0.95, -0.01em, wdth 68, tabular lining figures): the first thing an ad says. 25–26px in a line ad, a setup preview or a map card; 19px in a compact map card.
- **Distance** (800, 23px, 1, wdth 72, tabular): the km figure, right-aligned opposite the price, with its note (13px, 650, wdth 90) beneath. 18px in a line ad.
- **Choice** (800, 20px, 1.15, wdth 76): a setup answer's title.
- **Ad title** (600, 16px, 1.3): the listing's own title; clamped to two lines in a line ad (15px).
- **Body** (400, 16px, 1.45): reading text. Paragraphs wrap `pretty`, headings `balance`.
- **Body small** (400, 14px, 1.45, Worn Ink): hints, notices, route lines, key-value rows.
- **Subhead** (850, 14px, 0.06em, wdth 80, uppercase): a sub-section inside a panel.
- **Action** (800, 14px, 0.06em, wdth 80, uppercase): every button, tab and segmented control. 15px on standalone buttons, 16px on the Open bar, 17px on the setup's wide button, 12.5px in the tab bar.
- **Label** (700, 12.5px, 0.05em, wdth 85, uppercase, tabular): the meta line (beds · type · site), the tally under the column head, the edition line, answer labels.
- **Badge** (750, 12.5px, 1.35, 0.05em, wdth 80, uppercase): marks set beside an ad; NEW is 900.

### Named Rules
**The Width Is Rank Rule.** Width sets rank before size does: the narrower the cut, the louder the role. Heads and prices 62–68%, figures 72%, labels and actions 75–85%, reading text 100%. Never wider than 100%.

**The Condensed Capitals Rule.** Anything that labels, acts or marks is condensed uppercase with positive tracking (0.03–0.06em). Anything that is read (titles, sentences, notices, hints) is sentence case at full width.

**The Figures In A Column Rule.** Prices, distances, counts and tallies use tabular figures, so a column of ads lines up like a printed one. Synthesised bold and italic are off (`font-synthesis: none`).

## Layout

One column, as a classifieds page is read on a phone: centred at a maximum of 720px, with 16px gutters (the content pads 4px 16px 28px). The map view widens the frame to 1280px. Ads stack 16px apart; sections stand 24px apart, each opened by a 3px ink rule; rows inside a box run on about 9px of padding divided by hairlines.

The masthead (name, a 3px-over-1px double rule, the edition line) heads every screen. The tab bar is fixed to the foot (60px plus the safe area, ruled 2px above), and the page pads its bottom by the same amount. The status bar sits on a fixed strip of ink the height of the top safe area (`viewport-fit=cover`), so the list scrolls under it. Settings keep a sticky save bar just above the tabs. The guided setup is its own narrower column (560px), one question per screen, no tab bar, a 5px progress track under the top bar.

Breakpoints:
- **640px:** a display ad sets its photo beside the copy (photo column 44%, at least 220px tall); a line ad's thumbnail grows from 96px to 132px.
- **760px:** the tab bar centres under the column (each tab at most 180px); the map stops bleeding to the screen edges and is boxed in ink with a 14px top margin.

The map fills what remains below the masthead, column head and tabs (`100dvh` less 236px and the safe areas, never under 380px) and bleeds to the edges on a phone.

Touch targets are 44px at minimum everywhere: standalone buttons and fields 46px, the Open bar 52px, the setup's wide button 54px, tabs 56px, setup choices 60px. Underlined text actions are padded out to a 44px target rather than enlarged.

## Elevation & Depth

The paper is flat. Depth is conveyed by rules and stock: a box is a lighter sheet (sheet on paper) inside an ink edge, and weight of rule says how much a thing matters. Shadow is reserved for what floats over the page and must be read as detached from it.

### Shadow Vocabulary
- **Float** (`box-shadow: 0 2px 10px rgb(20 20 20 / 0.18), 0 1px 2px rgb(20 20 20 / 0.12)`; night `0 2px 12px rgb(0 0 0 / 0.6), 0 1px 2px rgb(0 0 0 / 0.5)`): the toast, the refresh pill that offers new listings while the list is scrolled, the Home Screen pointer, the map's key panel, hover card and note.
- **Pin** (`box-shadow: 0 2px 6px rgb(0 0 0 / 0.3)`): price pins on the map; approximate-area chips take `0 1px 4px rgb(0 0 0 / 0.3)`, the campus star `0 1px 4px rgb(0 0 0 / 0.4)`.
- **Sheet rise** (`box-shadow: 0 -6px 24px rgb(0 0 0 / 0.35)`): the bottom sheet that rises when a pin is tapped on a phone, over a 50% black backdrop.

### Named Rules
**The Rule, Not Shadow Rule.** Anything that sits on the page (an ad, a panel, a notice, a field, a tab bar) is ruled, never shadowed. A shadow means the thing is floating over the page and will go away.

## Shapes

Square-cut, as type is set in a box. Ads, badges, notices, the Open bar and map pins have no radius (0). Controls are just off the knife (2px): buttons, fields, the List/Map control, setup choices and pills, the toast, map controls and panels. Only two things are round (50%): the campus star on the map and the pen-blue waiting dot in setup. The one softer corner, 6px, belongs to the drawn Safari buttons in the iPhone install steps, because it depicts someone else's interface.

Rules come in a fixed set of weights: 3px ink to open a section, under the column head, under the masthead (over a 1px rule) and atop the bottom sheet; 2px ink for the tab bar, the save bar, and boxes that ask for something; 1.5px ink for controls, marks set dashed and map pieces; 1px ink for an ad's box and its photo edge; 1px Hairline Grey between rows inside a box.

Line style is meaning. Solid: known and read (an ad's box, a fact badge, the search radius on the map, the campus outline). Dashed (1.5px): approximate, late or unchecked (a partial or stale sources notice with the alert icon, a "check …" badge, an approximate distance's underline, approximate areas on the map and in its key, the offline banner, the map's note). Dotted: not being checked right now (waiting, paused, catching up, with the pause icon).

The marks are drawn by hand, not set: the highlighter is a slightly rotated, ragged-ended band (the masthead's at -1.6deg with an irregular corner, the price's as a 97deg gradient with feathered ends, the NEW badge tilted -1.5deg); the pen ring is a single open SVG stroke (2.6, round caps, non-scaling) that overshoots its start; the strike-out is a 3px pen bar at -2.5deg. Every disclosure says so with a drawn plus (two bars, 12px by 2px, 14px by 2.5px on section summaries) that loses its upright when open. Icons are one set: inline SVG on a 24px grid, 2px round strokes in the text colour, drawn at 16px inline, 18px in the install steps and 22px in the tab bar.

### Named Rules
**The Solid Is Known Rule.** A solid line is something known; a dashed line is approximate or unchecked; a dotted one is not being checked. The search radius is drawn solid because it is exact. Never dash something exact, never draw a guess solid.

**The Knife Rule.** Nothing on the paper is rounder than 2px. A rounded box is a portal card, not an ad.

## Components

### Buttons
Type-set and blunt: condensed capitals in a ruled box.
- **Shape:** just off the knife (2px), 1.5px ink edge, at least 46px tall (padding 11px 18px).
- **Primary:** Press Black fill, Reversed-Out Paper type. The setup's wide primary runs full width at 54px and 17px.
- **Secondary:** transparent with an ink edge and ink type.
- **Remove (danger):** a secondary button in the red pen (red edge, red type). The only red control in the system.
- **Link-like:** ink type at 700 with a 1.5px underline offset 3px, padded to a 44px target; used for "Not now", "Change", "Try again".
- **Hover / Focus / Press:** on hover-capable devices only, primary mixes 14% paper into the ink and secondary takes the sheet; focus is the 3px ballpoint ring at a 2px offset; press nudges down 1px. Disabled sits at 45% opacity.

### Ads (signature component)
The column is made of two kinds of ad, as a paper's classifieds are.
- **Display ad** (anything not yet marked): a 1px ink box on sheet. Photo across the top at 2:1 with an ink rule under it; then the lead line (price left, distance right with its note under it, figures tabular); the title; the meta line in condensed capitals; up to four route lines, each with its mode icon; the badges. Under the copy, the way on fills a 52px bar of ink ("Open on <site>" with the external icon), and "Not a fit" and "More" share a ruled row beneath it (1px hairline gaps). At 640px and up the photo moves beside the copy.
- **Line ad** (any ad with a mark: seen, not a fit, no longer available): gives up its display space and keeps a 96px thumbnail (132px from 640px). Price drops to 25px, distance to 18px, the title clamps to two lines. Its three actions share one ruled row (Open 1.6fr, Not a fit 1fr, More 1fr) and Open is no longer filled with ink. If the site's name is longer than 10 characters, or More is open, Open takes a row of its own and the rest share the row below.
- **New:** the price is gone over with the highlighter (black ink on yellow in both editions) and the NEW badge leads the marks.
- **Arrived from an alert:** the price is circled in ballpoint; the ring draws itself once in 0.75s (`cubic-bezier(0.22, 0.8, 0.24, 1)`) and is simply there under reduced motion.
- **Put away** (Not a fit, No longer available): struck through in pen before it moves (0.26s, `cubic-bezier(0.3, 0.7, 0.2, 1)`), then settles as a line ad with the strike across the price, the title in Worn Ink and the photo greyscale at 55%. A put-away ad's only action is the one that undoes it ("Restore", "Still available"), across the full row in ballpoint.
- **Seen:** price in Worn Ink and a ballpoint tick badge.
- **Put-away sections** sit under the column as collapsible sections with a 1.5px rule and the drawn plus.

### Badges
- **Style:** square, 1px Worn Ink edge, transparent, condensed capitals (12.5px, 750, 0.05em), 2px 6px.
- **Facts** ("listed 4 h ago", "available now", "also on …") take the plain box; a direct route beyond the radius takes a full ink edge.
- **To check** ("check distance", "check owner-occupied", "availability not stated", "ends …") take a 1.5px dashed ink edge.
- **NEW** is a highlighter block, no edge, 900 weight, tilted -1.5deg. **Seen** is unboxed ballpoint text led by a drawn tick.

### Inputs / Fields
- **Style:** sheet fill, 1.5px Field Edge stroke (3:1 against the page), 2px corners, 46px tall, 10px 12px padding, 16px type; placeholder in Faded Ink. The caret is ballpoint.
- **Labels:** 14px at 700 above the field; hints under it at 14px in Worn Ink.
- **Checks and radios:** 22px, accent in ink, on a 44px row.
- **Focus:** the 3px ballpoint ring.
- **Error:** a message in the red pen under the form (14px, 600).

### Navigation
- **Tabs, at the foot:** fixed to the bottom on paper under a 2px ink rule; each tab an icon (22px) over a label in condensed capitals (12.5px, 800). Inactive tabs are Faded Ink; the current one is ink under a 5px ink bar at its top edge, so it never relies on colour. A count sits in a small 1px box, reversed out of ink on the current tab. Focus rings sit inset (-4px).
- **List / Map:** two type-set tabs in a 1.5px ink box with a rule between; the one in use is reversed out of ink. 44px tall.

### Notices
Plain, never alarming; icon and words carry the state.
- **Sources notice** (under the column head): one line with an icon. All read: a check and a hairline under it. Partial, late, down or failed: an alert icon in a 1.5px dashed ink box. Waiting, paused or catching up: a pause icon in a 1.5px dotted box.
- **Alerts notice above the column:** a plain 1px ink box on sheet with a 16px, 750, sentence-case head at full width beside its icon. It is information, not a headline, so the first ad stays in view.
- **Lines kept above the column** (alerts put away with "Not now", the Android install offer): a slim 1px ink box on sheet with the action at the right.
- **Offline:** a sheet band under a 1.5px dashed rule.
- **Viewing as:** a sticky highlighter band with a 2px ink rule, condensed capitals, and an "Exit" button drawn in its own ink.

### Sections and Disclosures
- A section opens under a 3px ink rule with its head as a Title. Boxes that ask for something (turning on alerts, a link to send) are framed in 2px ink on sheet with 14px 16px padding.
- Every disclosure (each details summary) uses the drawn plus at the right, never the browser's triangle; the plus loses its upright when open.
- Settings show each setup answer as a row (Label left, answer, "Change" at the right) between hairlines; "All settings" opens under a 3px-over-1px rule like the masthead's.

### Guided Setup
- One question per screen in a 560px column: top bar (name at 28px, back, "2 of 5" count), a 5px ink progress bar on a hairline track (0.3s, `cubic-bezier(0.22, 0.8, 0.24, 1)`), the question as a Headline, then the answers.
- **Choices:** full-width 60px boxes (1.5px ink, 2px corners, sheet) with a condensed title and a small sub-line; chosen is reversed out of ink. Budgets sit two to a row.
- **Pills:** 46px boxes in a wrapping row, same treatment.
- **Home Screen pointer:** an ink bubble in condensed capitals with an arrow icon, pinned against Safari's toolbar and nudging 6px on a 1.4s loop (still under reduced motion). Safari's own buttons are drawn inline in the steps as small outlined keys.

### Map
- Streets in newsprint grey (tiles greyscale, slightly flattened; inverted at night), so only prices, routes and marks carry colour.
- **Price pins:** tiny classifieds: sheet, 1.5px ink edge, square, 13px condensed figures, a ruled pointer underneath; highlighter when new; a count reversed out of ink when several share a spot.
- **Approximate areas:** dashed 2px ink outline with an 8% ink fill (20% when raised) and a dashed chip. **Search radius:** a solid 2px ink circle. **Campus:** a ballpoint outline at 12% fill, and a ballpoint disc with a star and an ink label in condensed capitals.
- **Panels and the hover card:** sheet, 1.5px ink edge, 2px corners, the Float shadow; zoom controls are 40px ink-edged squares. On a phone, tapping a pin raises a bottom sheet under a 3px ink rule.

### Masthead and Home Screen Icon
- **Lockup:** "ASAP" at 900, wdth 62, gone over with a tilted highlighter swipe, then "accommodation" at 750, wdth 72, in ink; over a 3px-and-1px double rule and the edition line ("Within 2 km of …") in Label capitals.
- **Home Screen icon** (label "ASAP"): a column of ads in newsprint on ink, four square-cut lines of type, the second gone over with the highlighter, all inside the middle 80% so it can be masked. Drawn by `scripts/make-icons.mjs`, which writes its provenance into each PNG.

### Toast
An ink slip at the foot, above the tabs (2px corners, the Float shadow, max 480px), 14px at 650 in Reversed-Out Paper, with an underlined action in condensed capitals. It stays in the page empty so a screen reader announces each message.

## Do's and Don'ts

### Do:
- **Do** set the page on Newsprint (#f0efea) and box every ad, notice and field on Boxed-Ad Stock (#fbfbf8) inside an ink edge: 1px for an ad, 3px to open a section.
- **Do** keep Highlighter Yellow (#f7e933) for what is new and the few things you would go over with a highlighter, always with black ink on it, in both editions.
- **Do** keep Ballpoint Blue (#2340b8) for the reader's own marks and the one focus ring (3px, 2px offset; inset -4px inside clipped cells and tabs).
- **Do** keep the red pen (#c0251b) to error messages and the Remove button, so a failure can be told apart at a glance.
- **Do** dash what is approximate or unchecked (1.5px) and draw what is exact solid, the search radius included.
- **Do** carry every state in an icon and words as well as line style; colour alone never says anything.
- **Do** set heads and prices narrow and heavy (wdth 62–68, 850–900) and labels and actions in condensed capitals (wdth 75–85, 0.05–0.06em); keep reading text at 100%.
- **Do** set prices, distances and counts in tabular figures.
- **Do** run an unmarked ad as a display ad and any ad with a mark as a line ad, its three actions on one ruled row unless the site's name is longer than 10 characters.
- **Do** keep the alerts notice above the column a plain notice: sentence case, full width, 16px, 1px box.
- **Do** use the drawn plus on every disclosure.
- **Do** give every control a 44px target, and let the pen ring, the strike and the pointer sit still under reduced motion.

### Don't:
- **Don't** build the property-portal card stack: rounded white cards, brand-colour buttons, a system font.
- **Don't** add a colour beyond the highlighter, the ballpoint and the red pen; colour lives only in photos, the map and those marks.
- **Don't** fill a call to action with yellow or blue; the way on is ink, reversed out.
- **Don't** use red for warnings, badges or emphasis; a "check …" is a dashed box, not a red one.
- **Don't** round anything on the paper past 2px, and don't round ads, badges or notices at all.
- **Don't** put a shadow on anything that sits on the page; only the toast, the pointer, the refresh pill and the map's floating pieces cast one.
- **Don't** dash anything exact, or draw a guess with a solid line.
- **Don't** set Archivo wider than 100%, or let the browser synthesise bold or italic.
- **Don't** turn the alerts notice above the column into a headline.
- **Don't** use the browser's disclosure triangle, or a character as an icon; draw icons on the 24px grid with 2px round strokes.
- **Don't** colour the map's streets; tiles stay greyscale so the prices, routes and marks carry the colour.
