import { fill, h, describeMatch, badgeRow, isNewMatch, listingImage } from "./ui.js";
import { clusterSpots, pinLabel, placeMatches } from "./map-model.js";

// OpenStreetMap's own tiles. Their usage policy wants a Referer (this site otherwise sends none) and attribution.
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';
const COLOURS = { radius: "#0f766e", campus: "#7c3aed", zone: "#d97706", zoneFill: "#f59e0b" };
const CLUSTER_PX = 44;
const STOP_MIN_ZOOM = 15;
const MAX_CARD_ITEMS = 6;
const POLL_MS = 4000;
const POLL_LIMIT = 60;

let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  leafletLoading ??= new Promise((resolve, reject) => {
    if (!document.getElementById("leaflet-css")) document.head.append(h("link", { id: "leaflet-css", rel: "stylesheet", href: "/vendor/leaflet/leaflet.css" }));
    const script = h("script", { src: "/vendor/leaflet/leaflet.js" });
    script.onload = () => resolve(window.L);
    script.onerror = () => {
      leafletLoading = null;
      script.remove();
      reject(new Error("Couldn't load the map library."));
    };
    document.head.append(script);
  });
  return leafletLoading;
}

const zoneHeading = (g) => (g.name ? `Somewhere in ${g.name}: exact address unknown` : "Approximate location only");
const groupLabel = (g) => (g.kind === "zone" ? `${g.items.length} listing${g.items.length > 1 ? "s" : ""}, ${g.name || "approximate area"}` : `${g.items.length} listing${g.items.length > 1 ? "s" : ""}, from ${pinLabel(g.items)}`);

// The map view. `update(state)` hands it the latest matches; it draws them once the element is on the page.
export function createMapView({ api, onShowList }) {
  const canvas = h("div", { class: "map-canvas", role: "region", "aria-label": "Map of matching rentals" });
  const status = h("div", { class: "map-status", role: "status" });
  const note = h("div", { class: "map-note", hidden: true });
  const card = h("div", { class: "hovercard", hidden: true });
  const el = h("div", { class: "map-wrap" }, canvas, status, note, card);

  const sheet = h("div", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": "Listing details", hidden: true });
  const backdrop = h("div", { class: "sheet-backdrop", hidden: true, onclick: () => closeSheet() });
  document.body.append(backdrop, sheet);

  let L = null;
  let map = null;
  let initialising = false;
  let current = null;
  let model = { spots: [], zones: [], unplaced: [] };
  let overlayKey = null;
  let fitted = false;
  let layers = null;
  let radiusCircle = null;
  let hideTimer = null;
  let pinned = null;
  let pollTimer = null;
  let polls = 0;
  let campusDrawn = false;
  let drawnTransitAt = null;
  let transit = null;
  let transitStatus = { state: "loading", error: null };
  let selectedRoute = null;
  let routeLines = new Map();
  const visible = { bus: true, rail: true, stops: true };
  let panelBody = null;
  let panelDetails = null;

  // Hover cards are for a mouse; a finger gets the bottom sheet. A hybrid device is judged by the last pointer used.
  const hoverCapable = window.matchMedia("(hover: hover) and (pointer: fine)");
  let lastPointer = "mouse";
  const touchLike = () => lastPointer === "touch" || !hoverCapable.matches;
  const track = (e) => {
    if (e.pointerType) lastPointer = e.pointerType === "pen" ? "mouse" : e.pointerType;
  };
  canvas.addEventListener("pointerdown", track, true);
  canvas.addEventListener("pointermove", track, true);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    closeSheet();
    unpin();
  });

  // --- listing details ---------------------------------------------------------------------------------------

  function listingLink(m, compact) {
    const d = describeMatch(m, current.config);
    return h(
      "a",
      { class: compact ? "mcard compact" : "mcard", href: m.url, target: "_blank", rel: "noopener noreferrer" },
      listingImage(m),
      h("div", { class: "body" }, h("div", { class: "price" }, d.price), h("div", { class: "title" }, m.title), h("div", { class: "meta" }, d.meta), d.transit.map((t) => h("div", { class: "transit" }, t)), badgeRow(d.badges)),
    );
  }

  function renderCard(group) {
    const many = group.items.length > 1;
    fill(card, 
      pinned === group ? h("button", { class: "hc-close", type: "button", "aria-label": "Close", onclick: () => unpin() }, "×") : null,
      group.kind === "zone" ? h("div", { class: "hc-head" }, zoneHeading(group)) : many ? h("div", { class: "hc-head" }, `${group.items.length} listings here`) : null,
      group.items.slice(0, MAX_CARD_ITEMS).map((m) => listingLink(m, many)),
      group.items.length > MAX_CARD_ITEMS ? h("div", { class: "hc-more" }, `+${group.items.length - MAX_CARD_ITEMS} more: zoom in, or use the list`) : null,
      many ? null : h("div", { class: "hc-hint" }, "Click to open the listing"),
    );
  }

  function positionCard(point) {
    const W = canvas.clientWidth;
    const H = canvas.clientHeight;
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    let x = point.x + 14;
    if (x + cw > W - 8) x = point.x - cw - 14;
    x = Math.max(8, Math.min(x, W - cw - 8));
    const y = Math.max(8, Math.min(point.y - ch / 2, H - ch - 8));
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
  }

  function showCard(group, point) {
    clearTimeout(hideTimer);
    if (pinned && pinned !== group) return;
    renderCard(group);
    card.hidden = false;
    positionCard(point);
  }

  function hideCard() {
    clearTimeout(hideTimer);
    if (pinned) return;
    card.hidden = true;
  }

  const scheduleHide = () => {
    clearTimeout(hideTimer);
    if (!pinned) hideTimer = setTimeout(hideCard, 180);
  };
  card.addEventListener("pointerenter", () => clearTimeout(hideTimer));
  card.addEventListener("pointerleave", scheduleHide);

  function unpin() {
    pinned = null;
    card.hidden = true;
  }

  function sheetItem(m) {
    const d = describeMatch(m, current.config);
    return h(
      "div",
      { class: "sheet-item" },
      listingImage(m),
      h(
        "div",
        { class: "body" },
        h("div", { class: "price" }, d.price),
        h("div", { class: "title" }, m.title),
        m.address && m.address !== m.title ? h("div", { class: "meta" }, m.address) : null,
        h("div", { class: "meta" }, d.meta),
        d.transit.map((t) => h("div", { class: "transit" }, t)),
        badgeRow(d.badges),
        h("a", { class: "btn", href: m.url, target: "_blank", rel: "noopener noreferrer" }, "View listing ↗"),
      ),
    );
  }

  function openSheet(group) {
    hideCard();
    const n = group.items.length;
    fill(sheet, 
      h("button", { class: "sheet-close", type: "button", "aria-label": "Close", onclick: () => closeSheet() }, "×"),
      group.kind === "zone" ? h("div", { class: "hc-head" }, zoneHeading(group)) : n > 1 ? h("div", { class: "hc-head" }, `${n} listings here`) : null,
      h("div", { class: "sheet-list" }, group.items.map(sheetItem)),
    );
    sheet.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add("sheet-open");
    sheet.scrollTop = 0;
    sheet.querySelector(".sheet-close")?.focus({ preventScroll: true });
  }

  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove("sheet-open");
  }

  // One handler for pins, area chips and area shapes: a finger opens the sheet; a mouse follows the listing link
  // (a pin that stands for several listings zooms in, or pins its card open when it cannot zoom further).
  function activate(group) {
    if (touchLike()) return openSheet(group);
    if (group.items.length === 1) {
      window.open(group.items[0].url, "_blank", "noopener,noreferrer");
      return;
    }
    if (group.spots?.length > 1 && map.getZoom() < 18) {
      map.fitBounds(L.latLngBounds(group.spots.map((s) => [s.lat, s.lng])).pad(0.4), { maxZoom: 18 });
      return;
    }
    pinned = group;
    showCard(group, map.latLngToContainerPoint([group.lat, group.lng]));
  }

  function wire(layer, group, anchor) {
    layer.on("mouseover", (e) => {
      if (!touchLike()) showCard(group, anchor(e));
    });
    layer.on("mouseout", () => {
      if (!touchLike()) scheduleHide();
    });
    layer.on("click", () => activate(group));
  }

  // --- listings ----------------------------------------------------------------------------------------------

  function pinIcon(group) {
    const many = group.items.length > 1;
    const html = h("div", { class: group.items.some(isNewMatch) ? "pin new" : "pin" }, h("span", {}, pinLabel(group.items)), many ? h("span", { class: "n" }, String(group.items.length)) : null).outerHTML;
    return L.divIcon({ className: "pin-wrap", html, iconSize: [0, 0], iconAnchor: [0, 0] });
  }

  function chipIcon(group) {
    const html = h("div", { class: "zone-chip" }, `≈ ${group.name || "approx. area"}`, group.items.length > 1 ? h("span", { class: "n" }, String(group.items.length)) : null).outerHTML;
    return L.divIcon({ className: "pin-wrap", html, iconSize: [0, 0], iconAnchor: [0, 0] });
  }

  function addMarker(group, icon, latlng, lift) {
    const marker = L.marker(latlng, { icon, keyboard: true, riseOnHover: true });
    const anchor = () => {
      const p = map.latLngToContainerPoint(latlng);
      return { x: p.x, y: p.y - lift };
    };
    wire(marker, group, anchor);
    marker.on("add", () => {
      const node = marker.getElement();
      node.setAttribute("aria-label", groupLabel(group));
      node.addEventListener("focus", () => {
        if (!touchLike()) showCard(group, anchor());
      });
      node.addEventListener("blur", scheduleHide);
    });
    return marker;
  }

  function addZone(group) {
    const style = { color: COLOURS.zone, weight: 2, dashArray: "6 5", fillColor: COLOURS.zoneFill, fillOpacity: 0.2, pane: "areas", bubblingMouseEvents: false };
    const shape = group.geometry ? L.geoJSON(group.geometry, { ...style, style: () => style }) : L.circle([group.lat, group.lng], { ...style, radius: group.radiusM });
    const raise = (on) => shape.setStyle({ fillOpacity: on ? 0.38 : 0.2, weight: on ? 3 : 2 });
    wire(shape, group, (e) => e.containerPoint);
    shape.on("mouseover", () => raise(true));
    shape.on("mouseout", () => raise(false));
    shape.addTo(layers.zones);
    const centre = group.geometry ? shape.getBounds().getCenter() : L.latLng(group.lat, group.lng);
    addMarker(group, chipIcon(group), centre, 14).addTo(layers.zones);
    group.centre = centre;
  }

  function redrawListings() {
    if (!map || !layers) return;
    if (!pinned) card.hidden = true;
    layers.spots.clearLayers();
    layers.zones.clearLayers();
    const clusters = clusterSpots(model.spots, (lat, lng) => map.project([lat, lng], map.getZoom()), CLUSTER_PX);
    for (const c of clusters) addMarker(c, pinIcon(c), [c.lat, c.lng], 30).addTo(layers.spots);
    for (const z of model.zones) addZone(z);

    const n = model.unplaced.length;
    note.hidden = n === 0;
    if (n) {
      fill(note, `${n} listing${n > 1 ? "s have" : " has"} no location to show. `, h("button", { type: "button", class: "linklike", onclick: onShowList }, "See them in the list"));
    }
  }

  function fit() {
    if (!map || !radiusCircle) return;
    const bounds = radiusCircle.getBounds();
    for (const s of model.spots) bounds.extend([s.lat, s.lng]);
    for (const z of model.zones) bounds.extend(z.centre ?? [z.lat, z.lng]);
    map.fitBounds(bounds.pad(0.08), { animate: false });
  }

  // --- campus, search radius and transport -------------------------------------------------------------------

  function drawBackdrop(config) {
    layers.backdrop.clearLayers();
    const { lat, lng, label } = config.center;
    radiusCircle = L.circle([lat, lng], { radius: config.radiusKm * 1000, color: COLOURS.radius, weight: 2, dashArray: "8 8", fill: false, interactive: false, pane: "backdrop" }).addTo(layers.backdrop);
    const html = h("div", { class: "campus-pin" }, h("span", { class: "star" }, "★"), h("span", { class: "lbl" }, label)).outerHTML;
    L.marker([lat, lng], { icon: L.divIcon({ className: "pin-wrap", html, iconSize: [0, 0], iconAnchor: [0, 0] }), interactive: false, keyboard: false, zIndexOffset: 1000 }).addTo(layers.backdrop);
  }

  function drawCampus(polygons) {
    layers.campus.clearLayers();
    for (const g of polygons ?? []) {
      L.geoJSON(g, { style: () => ({ color: COLOURS.campus, weight: 2, fillColor: COLOURS.campus, fillOpacity: 0.16 }), interactive: false, pane: "backdrop" }).addTo(layers.campus);
    }
    campusDrawn = polygons !== null;
  }

  const routeTip = (r) => h("div", {}, h("b", {}, r.ref || r.mode), r.label ? ` ${r.label}` : "", r.operator ? h("div", { class: "op" }, r.operator) : null);

  function styleRoutes() {
    for (const [id, { line, casing, route }] of routeLines) {
      const on = selectedRoute === id;
      const dim = selectedRoute !== null && !on;
      const weight = (route.nearCentre ? 5 : 3) + (on ? 2 : 0);
      line.setStyle({ weight, opacity: dim ? 0.15 : route.nearCentre || on ? 0.95 : 0.7 });
      casing.setStyle({ weight: weight + 4, opacity: dim ? 0.1 : 0.85 });
      if (on) {
        casing.bringToFront();
        line.bringToFront();
      }
    }
  }

  function drawTransit(data) {
    layers.bus.clearLayers();
    layers.rail.clearLayers();
    layers.stops.clearLayers();
    routeLines = new Map();
    for (const r of data.routes) {
      const group = r.mode === "bus" ? layers.bus : layers.rail;
      const common = { pane: "transit", lineCap: "round", lineJoin: "round", dashArray: r.mode === "rail" ? "10 7" : null };
      const casing = L.polyline(r.lines, { ...common, color: "#ffffff", interactive: false, dashArray: null }).addTo(group);
      const line = L.polyline(r.lines, { ...common, color: r.colour }).addTo(group);
      line.bindTooltip(routeTip(r), { sticky: true, direction: "top", className: "route-tip", opacity: 1 });
      routeLines.set(r.id, { line, casing, route: r });
    }
    for (const s of data.stops) {
      if (s.mode === "rail") {
        const m = L.circleMarker([s.lat, s.lng], { radius: 7, color: "#fff", weight: 2, fillColor: "#111827", fillOpacity: 1, pane: "stops" }).addTo(layers.rail);
        if (s.name) m.bindTooltip(s.name, { permanent: true, direction: "right", offset: [8, 0], className: "station-label" });
      } else {
        const m = L.circleMarker([s.lat, s.lng], { radius: 4, color: "#fff", weight: 1.5, fillColor: "#1d4ed8", fillOpacity: 1, pane: "stops" }).addTo(layers.stops);
        if (s.name) m.bindTooltip(s.name, { direction: "top", className: "route-tip", opacity: 1 });
      }
    }
    drawnTransitAt = data.fetchedAt;
    styleRoutes();
    syncLayers();
  }

  function syncLayers() {
    const set = (group, on) => {
      if (on && !map.hasLayer(group)) group.addTo(map);
      else if (!on && map.hasLayer(group)) map.removeLayer(group);
    };
    set(layers.bus, visible.bus);
    set(layers.rail, visible.rail);
    set(layers.stops, visible.stops && map.getZoom() >= STOP_MIN_ZOOM);
  }

  async function loadOverlay(retry = false) {
    clearTimeout(pollTimer);
    const key = overlayKey;
    if (retry) polls = 0;
    let data;
    try {
      data = await (retry ? api("POST", "/api/map/refresh") : api("GET", "/api/map"));
    } catch (err) {
      if (key === overlayKey) setTransitStatus("error", err.message);
      return;
    }
    if (key !== overlayKey || !map) return;
    if (data.campus && !campusDrawn) drawCampus(data.campus);
    if (data.transit && data.transit.fetchedAt !== drawnTransitAt) {
      transit = data.transit;
      drawTransit(data.transit);
    }
    setTransitStatus(data.transitStatus, data.transitError);
    if ((data.transitStatus === "loading" || data.campus === null) && ++polls < POLL_LIMIT) pollTimer = setTimeout(() => loadOverlay(), POLL_MS);
    else if (data.transitStatus === "loading") setTransitStatus("error", "OpenStreetMap is taking too long to answer.");
  }

  function setTransitStatus(state, error = null) {
    transitStatus = { state, error };
    renderPanel();
  }

  // --- the key and layer panel -------------------------------------------------------------------------------

  const keyRow = (swatch, text) => h("div", { class: "key-row" }, swatch, h("span", {}, text));

  function renderPanel() {
    if (!panelBody || !current) return;
    const { config } = current;
    const routes = transit?.routes ?? [];
    const count = (mode) => routes.filter((r) => r.mode === mode).length;
    const toggle = (name, label, n) =>
      h(
        "label",
        { class: "check" },
        h("input", {
          type: "checkbox",
          checked: visible[name],
          onchange: (e) => {
            visible[name] = e.target.checked;
            syncLayers();
          },
        }),
        n === null ? label : `${label} (${n})`,
      );
    const row = (r) =>
      h(
        "button",
        {
          type: "button",
          class: selectedRoute === r.id ? "route-row on" : "route-row",
          "aria-pressed": String(selectedRoute === r.id),
          title: r.operator || undefined,
          onclick: () => {
            selectedRoute = selectedRoute === r.id ? null : r.id;
            styleRoutes();
            renderPanel();
          },
        },
        h("i", { class: r.mode === "rail" ? "swatch dashed" : "swatch", style: `--c:${r.colour}` }),
        h("b", {}, r.ref || "Rail"),
        h("span", { class: "rl" }, r.label),
      );
    const near = routes.filter((r) => r.nearCentre);
    const rest = routes.filter((r) => !r.nearCentre);

    fill(panelBody, 
      h(
        "div",
        { class: "key" },
        keyRow(h("span", { class: "key-pin" }, "€650"), "Exact location"),
        keyRow(h("span", { class: "key-zone" }), "Approximate area: exact address unknown"),
        keyRow(h("span", { class: "key-campus" }, "★"), config.center.label),
        keyRow(h("span", { class: "key-radius" }), `${config.radiusKm} km search radius`),
      ),
      h("div", { class: "panel-title" }, "Public transport"),
      transitStatus.state === "loading" && !transit ? h("div", { class: "hint" }, "Loading bus and rail lines from OpenStreetMap…") : null,
      transitStatus.state === "error"
        ? h("div", { class: "msg err" }, `Couldn't load transport lines. ${transitStatus.error ?? ""} `, h("button", { type: "button", class: "linklike", onclick: () => loadOverlay(true) }, "Try again"))
        : null,
      transit ? [toggle("bus", "Bus lines", count("bus")), count("rail") ? toggle("rail", "Rail", count("rail")) : null, toggle("stops", "Bus stops (zoom in)", null)] : null,
      near.length ? [h("div", { class: "panel-title" }, `Serving ${config.center.label}`), near.map(row)] : null,
      rest.length ? [h("div", { class: "panel-title" }, "Elsewhere in the area"), rest.map(row)] : null,
      routes.length ? h("div", { class: "hint" }, "Tap a route to highlight it.") : null,
    );
  }

  function addControls() {
    const Panel = L.Control.extend({
      onAdd() {
        panelBody = h("div", { class: "panel-body" });
        panelDetails = h("details", { class: "map-panel" }, h("summary", {}, "Map key & transport"), panelBody);
        panelDetails.open = window.matchMedia("(min-width: 760px)").matches;
        L.DomEvent.disableClickPropagation(panelDetails);
        L.DomEvent.disableScrollPropagation(panelDetails);
        return panelDetails;
      },
    });
    new Panel({ position: "topright" }).addTo(map);

    const Fit = L.Control.extend({
      onAdd() {
        const box = h("div", { class: "leaflet-bar leaflet-control" });
        const a = h("a", { href: "#", role: "button", title: "Show everything", "aria-label": "Show everything", class: "map-fit" }, "⤢");
        L.DomEvent.disableClickPropagation(box);
        L.DomEvent.on(a, "click", (e) => {
          L.DomEvent.preventDefault(e);
          fit();
        });
        box.append(a);
        return box;
      },
    });
    new Fit({ position: "topleft" }).addTo(map);
  }

  // --- setup and updates -------------------------------------------------------------------------------------

  async function init() {
    if (map || initialising || !current) return;
    initialising = true;
    fill(status, "Loading map…");
    status.hidden = false;
    try {
      L = await loadLeaflet();
    } catch (err) {
      initialising = false;
      fill(status, `${err.message} `, h("button", { type: "button", class: "linklike", onclick: () => init() }, "Try again"));
      return;
    }
    status.hidden = true;
    initialising = false;

    const { center } = current.config;
    map = L.map(canvas, { minZoom: 9, maxZoom: 19, zoomSnap: 0.5 }).setView([center.lat, center.lng], 14);
    for (const [name, z] of [["backdrop", 350], ["areas", 380], ["transit", 420], ["stops", 430]]) map.createPane(name).style.zIndex = z;
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION, referrerPolicy: "origin" }).addTo(map);
    layers = {
      backdrop: L.layerGroup().addTo(map),
      campus: L.layerGroup().addTo(map),
      zones: L.layerGroup().addTo(map),
      spots: L.layerGroup().addTo(map),
      bus: L.layerGroup(),
      rail: L.layerGroup(),
      stops: L.layerGroup(),
    };
    addControls();
    map.on("zoomend", () => {
      redrawListings();
      syncLayers();
    });
    map.on("movestart", () => {
      if (!pinned) card.hidden = true;
    });
    map.on("click", () => {
      unpin();
      closeSheet();
    });
    apply();
  }

  function apply() {
    if (!map || !current) return;
    const { config } = current;
    const key = `${config.center.lat},${config.center.lng},${config.radiusKm}`;
    if (key !== overlayKey) {
      overlayKey = key;
      fitted = false;
      campusDrawn = false;
      drawnTransitAt = null;
      transit = null;
      transitStatus = { state: "loading", error: null };
      selectedRoute = null;
      polls = 0;
      drawBackdrop(config);
      layers.campus.clearLayers();
      for (const g of [layers.bus, layers.rail, layers.stops]) g.clearLayers();
      routeLines = new Map();
      loadOverlay();
    }
    model = placeMatches(current.matches, current.areas);
    redrawListings();
    if (!fitted) {
      fit();
      fitted = true;
    }
    renderPanel();
  }

  // The map cannot be laid out until it is on the page and has a size.
  new ResizeObserver(() => {
    if (!map) {
      if (canvas.clientWidth > 0 && canvas.clientHeight > 0) init();
    } else map.invalidateSize({ pan: false });
  }).observe(canvas);

  return {
    el,
    update(state) {
      current = { matches: state.matches, areas: state.areas ?? {}, config: state.config };
      if (map) apply();
      else if (canvas.clientWidth > 0) init();
    },
  };
}
