// The guided setup: what a new account sees instead of the app until it is watching somewhere. One question per screen,
// most answered with one tap, then how many places fit right now, then alerts on this device, then a short "how it
// works". The same question screens edit one answer at a time from Settings.
import { h, icon, describeMatch, leadRow, brand } from "./ui.js";
import { BUDGETS, KINDS, answersFromPrefs, collegeYearEnd, distanceChoices, euro, prefsFromAnswers, safariLayout, setupQuestions } from "./app-model.js";

const ALERTS_ASKED_KEY = "rw.alertsAsked";

// The preferences each question sets, when one is changed on its own from Settings.
const EDIT_FIELDS = {
  kind: ["sections"],
  budget: ["priceMax"],
  dates: ["needFrom", "stayUntil"],
  sharing: ["excludeOwnerOccupied", "excludeWeekdayOnly"],
  distance: ["radiusKm", "transitEnabled"],
};

export function alertsAsked() {
  try {
    return Boolean(localStorage.getItem(ALERTS_ASKED_KEY));
  } catch {
    return false;
  }
}

function markAlertsAsked() {
  try {
    localStorage.setItem(ALERTS_ASKED_KEY, String(Date.now()));
  } catch {}
}

// The taps that put the app on an iPhone's or iPad's Home Screen from Safari. No page can do it for them there, so each
// tap is spelt out, with the button drawn as it looks. `layout` is safariLayout().
export function iosSteps(layout, { big = false } = {}) {
  const key = (name) => h("span", { class: "key" }, icon(name, 18));
  const shareStep =
    layout === "compact"
      ? h("li", {}, "Tap ", key("more"), " at the bottom right, then tap ", h("strong", {}, "Share"), " ", key("share"), ".")
      : layout === "ipad"
        ? h("li", {}, "Tap the Share button ", key("share"), " at the top right.")
        : h("li", {}, "Tap the Share button ", key("share"), " at the bottom of the screen.");
  return h(
    "ol",
    { class: `steps${big ? " big" : ""}` },
    shareStep,
    h("li", {}, "Scroll down and tap ", h("strong", {}, "Add to Home Screen"), " ", key("add-home"), "."),
    h("li", {}, "Tap ", h("strong", {}, "Add"), layout === "compact" ? " (leave Open as Web App on)" : "", "."),
    h("li", {}, "Open ", h("strong", {}, "ASAP"), " from your Home Screen. It opens already signed in."),
  );
}

// A bubble at the edge of the screen pointing at the button the first step means, since it is in Safari's own toolbar,
// outside the page.
export function sharePointer(layout) {
  const text = layout === "compact" ? "Tap ⋯ here, then Share" : layout === "ipad" ? "Tap Share up here" : "Tap Share here";
  return h("div", { class: `pointer ${layout}`, "aria-hidden": "true" }, h("span", {}, text), icon(layout === "ipad" ? "arrow-up" : "arrow-down", 22));
}

// `ctx` is what the flow needs from the app: the current state and ways to change it.
//   state()            the latest /api/state
//   api, loadState, render, showToast
//   platform           devicePlatform() for this device
//   alertsMode()       alertsSetup() for this device; refreshPush() checks it again
//   turnOnAlerts()     asks for permission and subscribes; resolves true, or throws with a message to show
//   prepareHomeScreen  makes the Home Screen app open signed in (iPhone)
//   homeScreenMode()   homeScreenMode() for this device; promptInstall() shows the browser's own install prompt and
//                      resolves "accepted", "dismissed" or "unavailable"
//   signInLink()       a promise of a link that signs this account in on another browser on this device
//   waitForFirstCheck  looks again every few seconds until the first check has run
//   done(where)        leaves the flow: "matches" or "settings"
export function createSetup(ctx) {
  let flow = null;

  const go = (patch) => {
    flow = { ...flow, ...patch, error: null };
    ctx.render();
    window.scrollTo(0, 0);
    document.querySelector(".onboard h1")?.focus({ preventScroll: true });
  };

  function start({ step = "campus", edit = null, welcome = false } = {}) {
    const s = ctx.state();
    const answers = { ...answersFromPrefs(s.prefs), campus: s.campus?.id ?? null };
    // A new account is offered the end of this college year rather than a date that has passed.
    if (!s.campus && (!answers.stayUntil || answers.stayUntil < new Date().toISOString().slice(0, 10))) answers.stayUntil = collegeYearEnd();
    // `answered` is which one-tap questions have been answered in this run, so a new account isn't shown the defaults as
    // if it had picked them.
    flow = { step: edit ?? step, edit, welcome, answers, answered: new Set(), result: null, alertsStage: null, error: null, saving: false, custom: {} };
    ctx.render();
    window.scrollTo(0, 0);
    document.querySelector(".onboard h1")?.focus({ preventScroll: true });
  }

  const stop = (where = "matches") => {
    flow = null;
    ctx.done(where);
  };

  const questions = () => setupQuestions(flow.answers);

  // Moves on from a question: to the next one, or, after the last, saves everything at once.
  function next() {
    const a = flow.answers;
    const problem =
      flow.step !== "dates"
        ? null
        : flow.custom.moveMode === "date" && !a.moveIn
          ? "Pick the date you'd like to move in."
          : flow.custom.untilMode === "date" && !a.stayUntil
            ? "Pick the date you'd stay until."
            : a.moveIn && a.stayUntil && a.moveIn > a.stayUntil
              ? "The move-in date is after the date you'd stay until."
              : null;
    if (problem) {
      flow.error = problem;
      ctx.render();
      return;
    }
    if (flow.edit) return saveEdit();
    const qs = questions();
    const at = qs.indexOf(flow.step);
    if (at >= 0 && at < qs.length - 1) return go({ step: qs[at + 1] });
    return saveAll();
  }

  function back() {
    const qs = questions();
    const at = qs.indexOf(flow.step);
    if (at > 0) go({ step: qs[at - 1] });
  }

  async function saveAll() {
    go({ saving: true });
    try {
      const r = await ctx.api("POST", "/api/setup", { campus: flow.answers.campus, prefs: prefsFromAnswers(flow.answers) });
      await ctx.loadState();
      go({ saving: false, step: "preview", result: r });
      if (!r.matched) ctx.waitForFirstCheck();
    } catch (err) {
      flow = { ...flow, saving: false, error: err.message };
      ctx.render();
    }
  }

  // Only what the question was about is saved, so a setting made under All settings that the questions can't express (a
  // single Daft section, say) isn't rewritten by changing the budget.
  async function saveEdit() {
    const all = prefsFromAnswers(flow.answers);
    const changed = Object.fromEntries(EDIT_FIELDS[flow.edit].map((k) => [k, all[k]]));
    go({ saving: true });
    try {
      const r = await ctx.api("PUT", "/api/prefs", changed);
      await ctx.loadState();
      flow = null;
      ctx.done("settings");
      ctx.showToast(r.matched ? "Saved. Your matches are updated." : "Saved. It applies from the next check.");
    } catch (err) {
      flow = { ...flow, saving: false, error: err.message };
      ctx.render();
    }
  }

  const answer = (patch) => {
    flow.answers = { ...flow.answers, ...patch };
    flow.answered.add(flow.step);
    next();
  };

  // Whether to mark the current answer to a one-tap question: once it has been given, or when changing it from Settings.
  const shown = (step) => flow.edit !== null || flow.answered.has(step);

  // --- Pieces every screen shares ---------------------------------------------------------------------------------------

  // `pre` goes just above the question, such as a greeting.
  function head(title, lede, pre = null) {
    const qs = questions();
    const at = qs.indexOf(flow.step);
    const asking = at >= 0 && !flow.edit;
    return [
      h(
        "div",
        { class: "setup-top" },
        asking && at > 0
          ? h("button", { type: "button", class: "back", "data-fk": "setup:back", onclick: back }, icon("chevron-left", 20), "Back")
          : flow.edit
            ? h("button", { type: "button", class: "back", "data-fk": "setup:cancel", onclick: () => stop("settings") }, icon("chevron-left", 20), "Cancel")
            : asking && at === 0
              ? brand()
              : h("span"),
        asking ? h("span", { class: "setup-count" }, `${at + 1} of ${qs.length}`) : null,
      ),
      asking ? h("div", { class: "progress", "aria-hidden": "true" }, h("span", { style: `transform:scaleX(${((at + 1) / qs.length).toFixed(3)})` })) : null,
      pre ?? (flow.welcome && flow.step === "alerts" && !flow.alertsStage ? h("p", { class: "hello" }, "Welcome back!") : null),
      h("h1", { tabindex: "-1" }, title),
      lede ? h("p", { class: "lede-q" }, lede) : null,
    ];
  }

  // A big button that answers the question. `chosen` marks the current answer when coming back to a question.
  const choice = (title, sub, onclick, { chosen = false, fk } = {}) =>
    h(
      "button",
      { type: "button", class: `choice${chosen ? " chosen" : ""}`, "aria-pressed": String(chosen), "data-fk": fk, onclick, disabled: flow.saving },
      h("span", { class: "choice-title" }, title),
      sub ? h("span", { class: "choice-sub" }, sub) : null,
    );

  // Two or three small options side by side, for a question that shares a screen with another.
  const pills = (label, options, value, onpick) =>
    h(
      "fieldset",
      { class: "pills" },
      h("legend", {}, label),
      h(
        "div",
        { class: "pill-row" },
        options.map(([v, text]) =>
          h(
            "button",
            {
              type: "button",
              class: `pill${v === value ? " chosen" : ""}`,
              "aria-pressed": String(v === value),
              "data-fk": `pill:${label}:${v}`,
              onclick: () => {
                onpick(v);
                ctx.render();
              },
            },
            text,
          ),
        ),
      ),
    );

  const errorBox = () => (flow.error ? h("div", { class: "msg err", role: "alert" }, flow.error) : null);

  const continueButton = (label = flow.edit ? "Save" : "Continue") =>
    h("button", { type: "button", class: "primary wide", "data-fk": "setup:continue", disabled: flow.saving, onclick: next }, flow.saving ? "Saving..." : label);

  // Leaving the rest of the questions at their usual answers.
  const skipRest = () =>
    flow.edit || flow.step === "campus"
      ? null
      : h("button", { type: "button", class: "linklike skip", "data-fk": "setup:skip", disabled: flow.saving, onclick: saveAll }, "Skip the rest and start watching");

  // --- The questions ----------------------------------------------------------------------------------------------------

  function campusStep() {
    const s = ctx.state();
    const groups = new Map();
    for (const c of s.searchCampuses) groups.set(c.region, [...(groups.get(c.region) ?? []), c]);
    const first = s.user.name ? s.user.name.split(/\s+/)[0] : null;
    return [
      head(
        "Which college are you near?",
        "ASAP accommodation checks Daft.ie, Rent.ie, MyHome.ie and the college accommodation sites for you, and tells you when a new place comes up. It takes about a minute to set up.",
        h("p", { class: "hello" }, first ? `Hi ${first}!` : "Welcome!"),
      ),
      [...groups].map(([region, campuses]) =>
        h(
          "div",
          { class: "choice-group", role: "group", "aria-label": region },
          h("div", { class: "group-label" }, region),
          campuses.map((c) => choice(c.name, null, () => answer({ campus: c.id }), { chosen: flow.answers.campus === c.id, fk: `campus:${c.id}` })),
        ),
      ),
      h("p", { class: "hint" }, "Only these colleges are set up so far."),
    ];
  }

  function kindStep() {
    return [
      head("What are you looking for?"),
      // A budget offered for rooms means little for a whole house, so a new kind asks again; from Settings it is kept.
      KINDS.map((k) => choice(k.title, k.sub, () => answer({ kind: k.id, budget: flow.edit || flow.answers.kind === k.id ? flow.answers.budget : null }), { chosen: shown("kind") && flow.answers.kind === k.id, fk: `kind:${k.id}` })),
      skipRest(),
    ];
  }

  function budgetStep() {
    const a = flow.answers;
    const options = BUDGETS[a.kind] ?? BUDGETS.either;
    const typed = h("input", {
      type: "number",
      inputmode: "numeric",
      min: "50",
      step: "50",
      id: "setup-budget",
      "data-fk": "setup:budget",
      placeholder: "e.g. 750",
      value: flow.custom.budget ?? (a.budget && !options.includes(a.budget) ? a.budget : ""),
      oninput: (e) => (flow.custom.budget = e.target.value),
      onkeydown: (e) => e.key === "Enter" && useTyped(),
    });
    const useTyped = () => {
      const n = Math.round(Number(typed.value));
      if (!Number.isFinite(n) || n < 50) {
        flow.error = "Type a monthly amount in euro, like 750.";
        ctx.render();
        return;
      }
      flow.custom.budget = undefined;
      answer({ budget: n });
    };
    return [
      head("What's the most you'd pay a month?", "The monthly rent, as it's advertised."),
      h("div", { class: "choice-grid" }, options.map((n) => choice(`Up to ${euro(n)}`, null, () => answer({ budget: n }), { chosen: shown("budget") && a.budget === n, fk: `budget:${n}` }))),
      choice("No limit", "Show me everything", () => answer({ budget: null }), { chosen: shown("budget") && a.budget === null, fk: "budget:none" }),
      h("div", { class: "typed" }, h("label", { for: "setup-budget" }, "Or type an amount (€ a month)"), h("div", { class: "typed-row" }, typed, h("button", { type: "button", class: "secondary", "data-fk": "setup:budget-go", onclick: useTyped }, "Use this"))),
      errorBox(),
      skipRest(),
    ];
  }

  function datesStep() {
    const a = flow.answers;
    const yearEnd = collegeYearEnd();
    const today = new Date().toISOString().slice(0, 10);
    const moveMode = flow.custom.moveMode ?? (a.moveIn ? "date" : "now");
    const untilMode = flow.custom.untilMode ?? (!a.stayUntil ? "open" : a.stayUntil === yearEnd ? "year" : "date");
    const dateInput = (fk, value, min, onchange) => h("input", { type: "date", "data-fk": fk, value, min, "aria-label": fk === "setup:move" ? "Move in from" : "Stay until", onchange: (e) => onchange(e.target.value) });
    const yearLabel = new Date(`${yearEnd}T00:00:00Z`).toLocaleDateString("en-IE", { month: "long", year: "numeric", timeZone: "UTC" });
    return [
      head("When do you need it?", "Places that won't be free in time, or that end too early, are left out."),
      pills("Move in", [["now", "As soon as possible"], ["date", "From a date"]], moveMode, (v) => {
        flow.custom.moveMode = v;
        if (v === "now") a.moveIn = "";
      }),
      moveMode === "date" ? dateInput("setup:move", a.moveIn, today, (v) => (a.moveIn = v)) : null,
      pills("Stay until", [["year", `End of ${yearLabel}`], ["date", "Another date"], ["open", "Not sure"]], untilMode, (v) => {
        flow.custom.untilMode = v;
        if (v === "year") a.stayUntil = yearEnd;
        if (v === "open") a.stayUntil = "";
      }),
      untilMode === "date" ? dateInput("setup:until", a.stayUntil, a.moveIn || today, (v) => (a.stayUntil = v)) : null,
      errorBox(),
      continueButton(),
      skipRest(),
    ];
  }

  function sharingStep() {
    const a = flow.answers;
    return [
      head("Two quick ones about sharing"),
      pills("Would you live with the owner of the house?", [[false, "No"], [true, "Yes, that's fine"]], a.liveIn, (v) => (a.liveIn = v)),
      h("p", { class: "hint" }, "Some rooms are in the landlord's own home. They're left out unless you say yes."),
      pills("Do you need it 7 days a week?", [[false, "Yes, all week"], [true, "No, weekdays are enough"]], a.weekdays, (v) => (a.weekdays = v)),
      h("p", { class: "hint" }, "Some rooms near colleges are Monday to Friday only."),
      errorBox(),
      continueButton(flow.edit ? "Save" : "Start watching"),
    ];
  }

  // Only from Settings: the setup leaves distance at the campus's usual.
  function distanceStep() {
    const s = ctx.state();
    const a = flow.answers;
    const max = s.campus?.maxRadiusKm ?? 5;
    const options = distanceChoices(max);
    return [
      head(`How far from ${s.campus?.short ?? "campus"}?`, "Measured in a straight line, so allow a bit more on foot."),
      pills("Distance", options.map((km) => [km, `${km} km`]), options.includes(a.radiusKm) ? a.radiusKm : null, (v) => (a.radiusKm = v)),
      options.includes(a.radiusKm) ? null : h("p", { class: "hint" }, `Now: ${a.radiusKm} km (set under All settings).`),
      pills("Also places a bit further out with a direct bus or train?", [[true, "Yes"], [false, "No"]], a.transit, (v) => (a.transit = v)),
      errorBox(),
      continueButton(),
    ];
  }

  // --- After the questions ----------------------------------------------------------------------------------------------

  function savingScreen() {
    return [head("Finding places for you..."), h("p", { class: "lede-q" }, "Checking what's listed near your college right now.")];
  }

  function previewStep() {
    const s = ctx.state();
    const n = s.matches.length;
    const where = s.campus?.short ?? "your college";
    const top = s.matches.slice(0, 3);
    const title = !s.lastRun ? `Looking for places near ${where}` : n === 0 ? "Nothing fits right now" : n === 1 ? "1 place fits right now" : `${n} places fit right now`;
    const lede = !s.lastRun
      ? "This is the first look near your college, so it takes a few minutes. Your list fills in by itself."
      : n === 0
        ? "That's normal: good places come and go fast. You'll hear as soon as one is listed."
        : "They're on your list now. From here on you'll only hear about new ones, as soon as they're listed.";
    return [
      head(title, lede),
      top.length
        ? h(
            "div",
            { class: "preview" },
            top.map((m) => {
              const d = describeMatch(m, s.config);
              return h("div", { class: `preview-item${d.isNew ? " fresh" : ""}` }, leadRow(d), h("div", { class: "title" }, m.title), h("div", { class: "meta" }, d.meta));
            }),
            n > top.length ? h("div", { class: "hint" }, `and ${n - top.length} more`) : null,
          )
        : null,
      h("button", { type: "button", class: "primary wide", "data-fk": "setup:continue", onclick: () => go({ step: ctx.homeScreenMode() === "none" || ctx.homeScreenMode() === "installed" ? afterHome() : "home" }) }, "Continue"),
    ];
  }

  const afterHome = () => (ctx.alertsMode() === "on" ? "done" : "alerts");

  // --- The Home Screen ---------------------------------------------------------------------------------------------------
  // On an iPhone this is what makes alerts possible at all; on Android it makes ASAP accommodation open like any other app.

  // While Safari shows the iPhone steps, look every few seconds for the Home Screen app having been opened, so the page can
  // say it worked instead of leaving the person to wonder. The look stops when the step does.
  let watcher = null;
  function watchForHomeScreen() {
    if (watcher) return;
    const step = flow.step;
    flow.homeSince ??= ctx.state().serverTime;
    const tick = async () => {
      if (!flow || flow.step !== step || flow.homeDone) {
        clearInterval(watcher);
        watcher = null;
        document.removeEventListener("visibilitychange", onVisible);
        return;
      }
      if (document.hidden) return;
      try {
        await ctx.loadState();
      } catch {
        return;
      }
      const at = ctx.state()?.homeScreenAt;
      if (flow && at && at > flow.homeSince) {
        flow.homeDone = true;
        ctx.render();
      }
    };
    const onVisible = () => !document.hidden && tick();
    document.addEventListener("visibilitychange", onVisible);
    watcher = setInterval(tick, 3000);
  }

  async function install() {
    flow.busy = true;
    ctx.render();
    const outcome = await ctx.promptInstall();
    flow = { ...flow, busy: false };
    if (outcome === "accepted") go({ homeDone: true });
    else {
      flow.error = outcome === "dismissed" ? "No problem. You can add it later from the browser's menu." : null;
      ctx.render();
    }
  }

  function homeStep() {
    const mode = ctx.homeScreenMode();
    const p = ctx.platform;
    const later = (label = "I'll do this later") =>
      h("button", { type: "button", class: "linklike skip", "data-fk": "home:later", onclick: () => go({ step: p.ios ? "done" : afterHome() }) }, label);

    if (mode === "ios-elsewhere") {
      const note = h("div", { class: "msg", role: "status", "aria-live": "polite" });
      const link = ctx.signInLink();
      link.catch(() => {});
      return [
        head("Open this in Safari", "To get alerts on an iPhone, ASAP accommodation goes on your Home Screen, and only Safari can put it there."),
        h("button", { type: "button", class: "primary wide", "data-fk": "home:copy", onclick: () => copyLink(note, link) }, "Copy my link"),
        note,
        h("p", { class: "hint" }, "Your link keeps you signed in, so don't share it. Or look for Open in Safari in this app's menu."),
        later(),
      ];
    }

    if (mode === "ios-safari") {
      if (flow.homeDone) {
        return [
          head("It's on your Home Screen", "Carry on in the ASAP app: it's signed in and will ask to turn on alerts. You can close Safari now."),
          h("button", { type: "button", class: "primary wide", "data-fk": "home:ok", onclick: () => stop("matches") }, "OK"),
        ];
      }
      ctx.prepareHomeScreen();
      watchForHomeScreen();
      const layout = safariLayout(p);
      return [
        head("Add it to your Home Screen", "iPhones only send alerts from apps on the Home Screen. It takes a few taps, and you won't need to sign in again."),
        iosSteps(layout, { big: true }),
        h("p", { class: "waiting", role: "status" }, h("span", { class: "dot" }), "This page will notice when you've opened it."),
        later(),
        sharePointer(layout),
      ];
    }

    // Android (and the rare other browser that offers to install).
    if (flow.homeDone) {
      return [
        head("It's on your Home Screen", "Open ASAP from there any time. It's signed in already."),
        h("button", { type: "button", class: "primary wide", "data-fk": "setup:continue", onclick: () => go({ step: afterHome() }) }, "Continue"),
      ];
    }
    return [
      head("Add it to your Home Screen", "So ASAP accommodation opens like any other app, straight to your list."),
      mode === "prompt"
        ? h("button", { type: "button", class: "primary wide", "data-fk": "home:add", disabled: flow.busy, onclick: install }, icon("add-home", 20), " Add to Home Screen")
        : [
            h(
              "ol",
              { class: "steps big" },
              h("li", {}, "Tap ", h("span", { class: "key" }, icon("more-vertical", 18)), " at the top right of the browser."),
              h("li", {}, "Tap ", h("strong", {}, "Add to Home screen"), " or ", h("strong", {}, "Install app"), "."),
              h("li", {}, "Tap ", h("strong", {}, "Install"), " (or ", h("strong", {}, "Add"), ")."),
            ),
            h("button", { type: "button", class: "primary wide", "data-fk": "setup:continue", onclick: () => go({ step: afterHome() }) }, "Done"),
          ],
      errorBox(),
      later(mode === "prompt" ? "Not now" : "Skip this"),
    ];
  }

  async function turnOn() {
    flow.busy = true;
    flow.error = null;
    ctx.render();
    try {
      await ctx.turnOnAlerts();
      markAlertsAsked();
      go({ busy: false, alertsStage: "tested" });
    } catch (err) {
      flow = { ...flow, busy: false, error: err.message };
      ctx.render();
    }
  }

  async function sendAnother() {
    flow.busy = true;
    ctx.render();
    const r = await ctx.api("POST", "/api/test-push").catch((err) => ({ error: err.message }));
    flow = { ...flow, busy: false, error: r.error ?? (r.sent ? null : "It couldn't be sent to this device. Try turning alerts on again.") };
    ctx.render();
  }

  const skipAlerts = (label = "Skip for now") =>
    h(
      "button",
      {
        type: "button",
        class: "linklike skip",
        "data-fk": "setup:skip-alerts",
        onclick: () => {
          markAlertsAsked();
          go({ step: "done" });
        },
      },
      label,
    );

  // Safari only lets a page copy during the tap itself, so the link is asked for before the tap and handed over as a promise.
  // Where copying isn't allowed at all (some apps' own browsers), the link is shown to copy by hand.
  async function copyLink(note, link) {
    try {
      if (window.ClipboardItem && navigator.clipboard?.write) {
        await navigator.clipboard.write([new ClipboardItem({ "text/plain": link.then((t) => new Blob([t], { type: "text/plain" })) })]);
      } else {
        await navigator.clipboard.writeText(await link);
      }
      note.className = "msg ok";
      note.replaceChildren("Copied. Now open Safari, tap the address bar, paste and go.");
    } catch {
      const shown = h("input", { type: "text", readonly: true, value: await link.catch(() => ""), "aria-label": "Your sign-in link", onfocus: (e) => e.target.select() });
      note.className = "msg";
      note.replaceChildren("Copy this link, then paste it into Safari's address bar:", shown);
    }
  }

  function alertsStep() {
    const p = ctx.platform;
    const mode = ctx.alertsMode();

    if (mode === "on" && flow.alertsStage === "tested") {
      return [
        head("We've sent you a test alert", "It should pop up in the next few seconds. Did it arrive?"),
        choice("Yes, it arrived", null, () => go({ step: "done" }), { fk: "alerts:yes" }),
        choice("No, nothing yet", null, () => go({ alertsStage: "help" }), { fk: "alerts:no" }),
      ];
    }
    if (mode === "on" && flow.alertsStage === "help") {
      return [
        head("Let's find it", null),
        h(
          "ol",
          { class: "steps big" },
          h("li", {}, "Check your phone isn't on Do Not Disturb or a Focus mode."),
          p.ios
            ? h("li", {}, "Open Settings, then Notifications, then ASAP, and check Allow Notifications is on.")
            : h("li", {}, "Check notifications are allowed for this site in your browser's settings."),
          h("li", {}, "Alerts can take up to a minute when your phone is saving battery."),
        ),
        h("button", { type: "button", class: "primary wide", disabled: flow.busy, "data-fk": "alerts:again", onclick: sendAnother }, "Send another test"),
        errorBox(),
        choice("It's arrived now", null, () => go({ step: "done" }), { fk: "alerts:yes" }),
        skipAlerts("Carry on without it"),
      ];
    }
    if (mode === "on") {
      return [head("Alerts are on", "You'll get one on this device whenever a new place is listed."), h("button", { type: "button", class: "primary wide", "data-fk": "setup:continue", onclick: () => go({ step: "done" }) }, "Continue")];
    }

    if (mode === "install") return homeStep();

    if (mode === "blocked") {
      return [
        head("Alerts are blocked on this device", null),
        h("p", {}, p.ios ? "Open Settings, then Notifications, then ASAP, and switch on Allow Notifications. Then come back here." : "Allow notifications for this site in your browser's site settings (the icon next to the address), then come back."),
        h(
          "button",
          {
            type: "button",
            class: "primary wide",
            "data-fk": "alerts:recheck",
            onclick: async () => {
              await ctx.refreshPush();
              ctx.render();
            },
          },
          "I've done that",
        ),
        skipAlerts(),
      ];
    }

    if (mode === "unsupported") {
      return [
        head("This browser can't show alerts", p.android ? "Open the link in Chrome to get alerts on this phone." : "Your matches still show here. For alerts, open the link on your phone: Safari on an iPhone, Chrome on Android."),
        skipAlerts("Continue"),
      ];
    }

    // Off: one button, and a test alert straight after so there is proof it works.
    return [
      head(flow.welcome ? "Nearly done: turn on alerts" : "Turn on alerts", "Get a notification on this device as soon as a new place is listed. Good places go fast."),
      h("button", { type: "button", class: "primary wide", "data-fk": "alerts:on", disabled: flow.busy, onclick: turnOn }, icon("bell", 18), flow.busy ? " Turning on..." : " Turn on alerts"),
      h("p", { class: "hint" }, "Your phone will ask if ASAP can send notifications: choose Allow."),
      errorBox(),
      skipAlerts(),
    ];
  }

  function doneStep() {
    const s = ctx.state();
    const first = s.user.name ? `, ${s.user.name.split(/\s+/)[0]}` : "";
    const alertsOn = ctx.alertsMode() === "on";
    return [
      head(`You're all set${first}`),
      h(
        "ul",
        { class: "how" },
        h("li", {}, icon(alertsOn ? "bell" : "pause", 20), h("span", {}, alertsOn ? "When a new place is listed, you'll get an alert. Tap it to see the place." : "Alerts are off on this device. You can turn them on any time from the Alerts tab.")),
        h("li", {}, icon("external", 20), h("span", {}, "Each place shows its price and how far it is. Tap ", h("strong", {}, "Open on Daft.ie"), " (or wherever it's listed) to see the advert and contact the landlord.")),
        h("li", {}, icon("check", 20), h("span", {}, "Not for you? Tap ", h("strong", {}, "Not a fit"), " and it's moved out of the way.")),
        h("li", {}, icon("sliders", 20), h("span", {}, "Change what you're looking for any time under ", h("strong", {}, "Settings"), ".")),
      ),
      h("button", { type: "button", class: "primary wide", "data-fk": "setup:finish", onclick: () => stop("matches") }, s.matches.length ? "See my matches" : "Go to my list"),
    ];
  }

  function render() {
    const body = flow.saving && !flow.edit
      ? savingScreen()
      : {
          campus: campusStep,
          kind: kindStep,
          budget: budgetStep,
          dates: datesStep,
          sharing: sharingStep,
          distance: distanceStep,
          preview: previewStep,
          home: homeStep,
          alerts: alertsStep,
          done: doneStep,
        }[flow.step]();
    return h("div", { class: "onboard" }, body, flow.step === "campus" ? errorBox() : null);
  }

  // `reset` forgets the flow without drawing anything, for when the session has ended under it.
  return { start, stop, render, active: () => flow !== null, reset: () => (flow = null) };
}
