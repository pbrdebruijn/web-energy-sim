// Home Assistant dashboard card: the 3D house shows what solar, grid, battery and EV do right now,
// and the chart below shows today so far. Built into dist/energy-scene-card.js by `npm run build`.
import { createScene } from './scene.js';
import { daylight, N, DT } from './sim.js';
import { createChart, renderLabels, UI_CSS, hhmm, esc, kwh, pct, fmt, tr, setLocale, totalsHtml, totalsToggle } from './ui.js';
import { checkConfig, toValue, weatherFactor, historyPoints, bucket, pricesFromAttributes, buildDay, guessEntities, toFormData, fromFormData, POWER_KEYS, DEVICE_TYPES, entitiesFromEnergyPrefs, energyStatsFromPrefs, dayTotals, forecastSlots, cheapestHours, sunHours, actionFor } from './ha-data.js';

const LABEL_ENTITY = { solar: 'solar', home: 'home', grid: 'grid', batt: 'battery', ev: 'ev' };
const HISTORY_EVERY = 5 * 60e3, CHART_EVERY = 5e3, SCRUB_HOLD = 15e3;
// 30 fps is smooth enough for a dashboard and halves the GPU work on 60 Hz screens; 2 ms slack absorbs vsync jitter
const FRAME_MS = 1000 / 30 - 2;

const CARD_CSS = `
:host { display: block; --ink: var(--primary-text-color, #f0efec); --ink2: var(--secondary-text-color, #c3c2b7);
  --muted: var(--secondary-text-color, #898781); --hair: var(--divider-color, #2c2c2a); --axis: var(--divider-color, #383835);
  --tile: var(--secondary-background-color, rgba(127, 127, 127, .12)); }
ha-card { overflow: hidden; }
.stage { position: relative; overflow: hidden; }
.stage canvas { display: block; }
.clock { left: 12px; bottom: 12px; padding: 6px 10px; }
.clock time { font-size: 20px; }
.charts { position: relative; padding: 10px 14px 6px; }
.devices { position: absolute; top: 10px; right: 10px; z-index: 1; display: flex; flex-direction: column; gap: 4px; align-items: stretch; }
.devices button { all: unset; cursor: pointer; display: flex; justify-content: space-between; gap: 12px; padding: 3px 9px; border-radius: 6px;
  font-size: 12px; color: #c3c2b7; background: rgba(26, 26, 25, .88); border: 1px solid rgba(255, 255, 255, .1); border-left: 3px solid #3987e5; }
.devices button:focus-visible { outline: 2px solid #3987e5; }
.devices b { color: #f0efec; font-variant-numeric: tabular-nums; }
/* Narrow cards: smaller labels with only the main number */
.stage { container-type: inline-size; }
@container (max-width: 480px) {
  .tag { font-size: 10px; padding: 2px 6px; }
  .tag b { font-size: 12px; }
  .tag .mix, .tag .soc { display: none; }
  .devices button { font-size: 10px; padding: 2px 6px; }
  .clock time { font-size: 15px; }
  .clock small { display: none; }
}
.warn { margin: 0; padding: 8px 14px; color: var(--error-color, #db4437); font-size: 13px; }
`;

const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const hourOf = (d) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

class EnergySceneCard extends HTMLElement {
  // A new card uses the Energy dashboard's power sensors; for anything not set up there it starts with a guess to check in the editor
  static async getStubConfig(hass) {
    if (!hass) return {};
    const fromEnergy = entitiesFromEnergyPrefs(await energyPrefs(hass));
    return { entities: Object.fromEntries(Object.entries(guessEntities(hass.states)).filter(([k]) => !fromEnergy[k])) };
  }

  static async getConfigElement() {
    await loadHaForm();
    return document.createElement('energy-scene-card-editor');
  }

  setConfig(config) {
    checkConfig(config);
    this.config = config;
    if (this.isConnected) { this.teardown(); this.setup(); } // also covers a card placed on the page before its config
  }

  set hass(hass) {
    this._hass = hass;
    const locale = `${hass.locale?.language ?? hass.language}/${hass.config?.currency}`;
    if (locale !== this.locale) { this.locale = locale; setLocale(hass.locale?.language ?? hass.language, hass.config?.currency); this.labelKey = ''; this.chart?.draw(); }
    if (!this.prefsAsked) this.loadEnergyPrefs();
    if (!this.scene) return;
    if (!this.hist) this.loadHistory();
    this.applyLive();
  }

  getCardSize() { return Math.ceil(this.height / 50) + (this.config.chart === false ? 0 : 6); }
  getGridOptions() { return { columns: 12, min_columns: 3 }; }

  get height() { return Number(this.config.height ?? 420); }
  // Sensors from the Energy dashboard, overridden by the card config
  get entities() { return { ...this.fromEnergy, ...this.config.entities }; }

  // Extra devices, only the ones picked in the card config
  get devices() { return this.config.devices ?? []; }

  async loadEnergyPrefs() {
    this.prefsAsked = true;
    const prefs = await energyPrefs(this._hass);
    this.fromEnergy = entitiesFromEnergyPrefs(prefs);
    this.energyStats = energyStatsFromPrefs(prefs);
    this.loadTotals();
    this.loadForecast();
    const added = Object.keys(this.fromEnergy).some((k) => !this.config?.entities?.[k]);
    if (added && this.scene) { this.teardown(); this.setup(); } // rebuild once so labels, chart and flows include them
  }

  connectedCallback() { this.setup(); }
  disconnectedCallback() { this.teardown(); }

  setup() {
    if (this.scene || !this.config) return;
    const e = this.entities, withChart = this.config.chart !== false;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${UI_CSS}${CARD_CSS}</style><ha-card>
      <div class="stage" style="height:${this.height}px"><div class="clock"><time></time><small></small></div><div class="devices"></div><button class="totals-btn" hidden></button></div>
      <div class="totals" hidden></div>
      <p class="warn" hidden></p>
      ${withChart ? `<section class="charts"><div class="legend"></div>
        <svg class="chart" role="img" aria-label="Price, power and charge level today"></svg><div class="tip"></div></section>` : ''}
    </ha-card>`;
    const q = (s) => root.querySelector(s);
    this.q = q;
    const low = this.config.quality === 'low';
    // Reduced motion stops the animation and redraws once a second; low quality drops shadows and sharpness for old tablets
    this.still = matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this.frameMs = this.still ? 1000 : low ? 1000 / 20 - 2 : FRAME_MS;
    // Fill cost scales with pixel count, and 1.5 still looks sharp at card size
    this.scene = createScene(q('.stage'), { maxPixelRatio: low ? 1 : 1.5, shadows: !low, devices: this.devices, house: this.config.house });
    for (const [key, el] of Object.entries(this.scene.labels)) {
      const actionKey = LABEL_ENTITY[key], entityId = e[actionKey];
      if (!entityId && !actionFor(this.config, actionKey, 'tap')) continue;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.title = tr('Show details and history');
      this.bind(el, actionKey, entityId);
      el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); this.act(actionKey, entityId, 'tap'); } };
    }
    // Device chips: one button each, filled in by frame()
    q('.devices').innerHTML = this.devices.map((d, k) => `<button data-k="${k}" title="${tr('Show details and history')}"></button>`).join('');
    q('.devices').querySelectorAll('button').forEach((b, k) => this.bind(b, 'device', this.devices[k].entity));
    this.show = { batt: !!(e.battery || e.battery_soc), ev: !!(e.ev || e.ev_soc), price: !!e.price };
    this.chart = withChart && createChart({ svg: q('.chart'), tip: q('.tip'), legend: q('.legend'), box: q('.charts') }, (h) => {
      this.viewT = h;
      this.liveUntil = Date.now() + SCRUB_HOLD; // dragging the chart replays earlier today, then it returns to now
    });
    this.ro = new ResizeObserver(() => this.chart && this.chart.draw());
    if (withChart) this.ro.observe(q('.charts'));
    this.live = {};
    this.seen = {};
    this.devValues = [];
    this.devNames = {};
    this.weather = 1;
    this.evAnim = 0;
    this.r = buildDay({});
    this.version = 0;
    this.labelKey = ''; // new label elements after a config change must be filled again
    this.hist = null;
    // Only animate while the card is on screen; wall tablets keep dashboards open all day.
    this.io = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; if (this.visible) this.start(); });
    this.io.observe(this);
    this.timer = setInterval(() => { this.loadHistory(); this.loadTotals(); this.loadForecast(); }, HISTORY_EVERY);
    this.applyTotals = totalsToggle(q('.totals-btn'), q('.totals'), 'energy-scene-card:totals', true);
    this.renderTotals();
    if (this._hass) { this.loadHistory(); this.applyLive(); }
  }

  teardown() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearInterval(this.timer);
    this.io?.disconnect();
    this.ro?.disconnect();
    this.scene?.dispose();
    this.scene = this.chart = null;
  }

  // Tap and hold follow Home Assistant's tap_action and hold_action; without them a tap opens the details
  bind(el, key, entityId) {
    let timer, held = false;
    el.onpointerdown = () => { held = false; timer = setTimeout(() => { held = true; this.act(key, entityId, 'hold'); }, 500); };
    el.onpointerup = el.onpointerleave = el.onpointercancel = () => clearTimeout(timer);
    el.onclick = () => { if (!held) this.act(key, entityId, 'tap'); };
  }

  act(key, entityId, kind) {
    const action = actionFor(this.config, key, kind);
    if (!action) { if (kind === 'tap' && entityId) this.moreInfo(entityId); return; }
    this.dispatchEvent(new CustomEvent('hass-action', { bubbles: true, composed: true, detail: { config: { entity: entityId, [`${kind}_action`]: action }, action: kind } }));
  }

  moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId } }));
  }

  warn(text) {
    const el = this.q('.warn');
    el.hidden = !text;
    el.textContent = text;
  }

  async loadHistory() {
    const hass = this._hass;
    if (!hass || !this.scene) return;
    const start = midnight(), end = new Date();
    const ids = Object.entries(this.entities).filter(([k]) => k !== 'weather');
    this.hist = this.hist ?? {};
    try {
      const res = await hass.callWS({
        type: 'history/history_during_period', start_time: start.toISOString(), end_time: end.toISOString(),
        entity_ids: ids.map(([, id]) => id), minimal_response: true, no_attributes: true, significant_changes_only: false,
      });
      const invert = this.config.invert ?? [];
      this.hist = Object.fromEntries(ids.map(([k, id]) => [k,
        bucket(historyPoints(res[id], k, hass.states[id]?.attributes.unit_of_measurement, invert.includes(k)), +start, +end)]));
      this.histDay = +start;
    } catch (err) {
      console.warn('energy-scene-card: history did not load', err);
      this.histError = `${tr('History did not load')}: ${err.message ?? err}`;
    }
    this.applyLive(true);
  }

  // Today's kWh from the Energy dashboard's meters, the same numbers its own "today" view shows
  async loadTotals() {
    const hass = this._hass, stats = this.energyStats;
    if (!hass || !stats || this.config.totals === false) return;
    const ids = Object.entries(stats).flatMap(([kind, list]) => list.map((id) => [kind, id]));
    if (!ids.some(([kind]) => kind !== 'cost' && kind !== 'compensation')) return;
    const sum = {};
    await Promise.all(ids.map(async ([kind, id]) => {
      const res = await hass.callWS({ type: 'recorder/statistic_during_period', statistic_id: id, calendar: { period: 'day' }, types: ['change'], units: { energy: 'kWh' } })
        .catch(() => null); // a meter without statistics leaves its kind at zero
      sum[kind] = (sum[kind] ?? 0) + (Number(res?.change) || 0);
    }));
    this.totals = dayTotals(sum, stats.cost.length + stats.compensation.length > 0);
    this.renderTotals();
  }

  // Solar forecast for today from the forecast linked in the Energy dashboard (Forecast.Solar and others)
  async loadForecast() {
    if (!this._hass || !this.prefsAsked) return;
    this.forecast = forecastSlots(await this._hass.callWS({ type: 'energy/solar_forecast' }).catch(() => null), +midnight());
    this.applyLive(true);
  }

  renderTotals() {
    const el = this.q?.('.totals'), T = this.totals;
    if (!el || !T) return;
    el.innerHTML = totalsHtml([
      [kwh(T.imported), 'Imported today'], [kwh(T.exported), 'Exported today'], [kwh(T.solar), 'Solar today'],
      T.selfSufficient != null && [pct(T.selfSufficient), 'Covered without the grid'],
      T.cost != null && [fmt.money(T.cost), 'Energy cost today'],
    ]);
    this.q('.totals-btn').textContent = tr('Totals');
    this.applyTotals();
  }

  // Merge the current states into today's history; the slot for "now" shows the live values.
  applyLive(force = false) {
    const hass = this._hass, e = this.entities;
    if (!hass || !this.scene) return;
    const ids = [...Object.values(e), ...this.devices.map((d) => d.entity)];
    if (!force && ids.every((id) => hass.states[id] === this.seen[id])) return; // nothing of ours changed
    this.devValues = this.devices.map((d) => {
      const st = hass.states[d.entity];
      this.seen[d.entity] = st;
      if (!st) return null;
      this.devNames[d.entity] = d.name ?? st.attributes.friendly_name ?? d.entity;
      return toValue('home', st.state, st.attributes.unit_of_measurement);
    });
    const invert = this.config.invert ?? [], missing = [];
    let prices = null;
    for (const [k, id] of Object.entries(e)) {
      const st = hass.states[id];
      this.seen[id] = st;
      if (!st) { missing.push(id); continue; }
      if (k === 'weather') { this.weather = weatherFactor(st.state); continue; }
      this.live[k] = toValue(k, st.state, st.attributes.unit_of_measurement, invert.includes(k));
      if (k === 'price') prices = pricesFromAttributes(st.attributes, st.attributes.unit_of_measurement, +midnight());
    }
    if (!e.grid && this.prefsAsked) missing.push(tr('no grid power sensor. Pick one in the card editor, or add one to the Energy dashboard'));
    missing.push(...this.devices.filter((d) => !hass.states[d.entity]).map((d) => d.entity));
    this.warn(missing.length ? `${tr('Entity not found')}: ${missing.join(', ')}` : this.histError ?? '');

    const i = Math.min(N - 1, Math.floor(hourOf(new Date()) / DT));
    const slots = {};
    for (const k of Object.keys(e)) {
      if (k === 'weather') continue;
      const day = (k === 'price' && prices) || (this.histDay === +midnight() && this.hist?.[k]) || new Array(N).fill(null);
      slots[k] = day.slice();
      if (!(k === 'price' && prices)) slots[k][i] = this.live[k] ?? null;
    }
    this.r = buildDay(slots);
    this.version++;
    if (this.chart && (force || !(Date.now() - this.drawnAt < CHART_EVERY))) {
      this.drawnAt = Date.now();
      const now = hourOf(new Date()), n = Number(this.config.cheapest_hours ?? 3);
      this.chart.draw(this.r, { ...this.show, forecast: this.forecast, now, cheap: n > 0 && this.show.price ? cheapestHours(this.r.buy, now, n) : null });
    }
  }

  start() {
    if (this.raf || !this.scene) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  frame = (ts) => {
    this.raf = 0;
    if (!this.scene || !this.visible) return;
    if (ts - this.last < this.frameMs) { this.raf = requestAnimationFrame(this.frame); return; }
    this.frames = (this.frames ?? 0) + 1; // rendered frames, read by bench.js
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    const now = new Date();
    if (this.histDay && this.histDay !== +midnight(now)) { this.histDay = 0; this.loadHistory(); } // a new day started
    const live = !(Date.now() < this.liveUntil);
    const t = live ? hourOf(now) : this.viewT;
    const i = Math.min(N - 1, Math.floor(t / DT));
    const r = this.r, away = r.evAway[i];
    this.evAnim = this.still ? +away : this.evAnim + ((away ? 1 : 0) - this.evAnim) * Math.min(1, dt * 1.5); // drive off and back in smoothly

    const key = `${i}/${this.version}/${live}`;
    if (key !== this.labelKey) {
      this.labelKey = key;
      renderLabels(this.scene.labels, r, i, { batt: this.show.batt, ev: this.show.ev, evName: this.config.ev_name ?? 'EV', away });
      this.q('.devices').querySelectorAll('button').forEach((b, k) => { // devices show their live power, also while replaying earlier today
        const d = this.devices[k];
        b.innerHTML = `<span>${esc(this.devNames[d.entity] ?? d.entity)}</span><b>${fmt.num(Math.abs(this.devValues[k] ?? 0), 1)} kW</b>`;
      });
      this.q('.clock small').innerHTML = `${tr(live ? 'Now' : 'Earlier today')}${r.buy[i] == null ? '' : `<br>${fmt.money(r.buy[i], 3)} ${tr('per kWh')}`}`;
      this.renderTotals(); // follows a language change
    }
    const clock = hhmm(Math.floor(t * 12) / 12), timeEl = this.q('.clock time');
    if (timeEl.textContent !== clock) timeEl.textContent = clock;
    this.chart && this.chart.playhead(t);
    const month = now.getMonth(), { rise, set } = sunHours(this._hass?.states['sun.sun']) ?? daylight(month); // sun.sun knows the home's location
    this.scene.update({
      t, month, rise, set, weather: this.weather, kWp: Number(this.config.solar_kwp ?? 5.5),
      solar: r.solar[i] ?? 0, home: r.home[i] ?? 0, ev: r.ev[i] ?? 0, batt: r.batt[i] ?? 0, grid: r.grid[i] ?? 0,
      battSoc: r.battSoc[i] ?? 0, battOn: this.show.batt, evOn: this.show.ev, evAway: this.evAnim, evPlugged: !away, devices: this.devValues, effects: this.config.effects !== false, still: this.still,
    }, dt);
    this.raf = requestAnimationFrame(this.frame);
  };
}

// ---- Visual editor: Home Assistant's own form with entity pickers ----
const sensor = { entity: { filter: { domain: 'sensor' } } };
const FIELDS = [
  ['grid', 'Grid power', 'Positive when importing, negative when exporting. Empty: the power sensor from the Energy dashboard', sensor],
  ['solar', 'Solar power', 'Empty: the power sensor from the Energy dashboard', sensor],
  ['battery', 'Home battery power', 'Positive when discharging into the house. Empty: from the Energy dashboard', sensor],
  ['battery_soc', 'Home battery level', 'Empty: from the Energy dashboard', sensor],
  ['ev', 'EV charger power', 'Positive when charging the car', sensor],
  ['ev_soc', 'Car battery level', null, sensor],
  ['ev_plugged', 'Car plugged in', 'On or home while the car is plugged in. Without it the car stays parked.', { entity: { filter: [{ domain: 'binary_sensor' }, { domain: 'device_tracker' }] } }],
  ['home', 'House consumption', 'Empty: from the Energy dashboard, or worked out from the other sensors', sensor],
  ['price', 'Electricity price', 'In € or ct per kWh', sensor],
  ['weather', 'Weather', 'Clouds and sunshine in the scene', { entity: { filter: { domain: 'weather' } } }],
  ['invert', 'Reverse the sign of', 'Pick a sensor here when its flow runs the wrong way in the scene', {
    select: { multiple: true, mode: 'list', options: POWER_KEYS.map((k) => ({ value: k, label: { solar: 'Solar power', grid: 'Grid power', battery: 'Home battery power', ev: 'EV charger power', home: 'House consumption' }[k] })) },
  }],
  ['ev_name', 'Car name', 'Shown on the car label', { text: {} }],
  ['solar_kwp', 'Solar peak power', 'Sets how many panels the roof shows', { number: { min: 0.5, max: 30, step: 0.5, unit_of_measurement: 'kWp', mode: 'box' } }],
  ['height', 'Scene height', null, { number: { min: 200, max: 1000, step: 10, unit_of_measurement: 'px', mode: 'box' } }],
  ['chart', 'Show the chart of today', null, { boolean: {} }],
  ['totals', "Show today's totals", 'From the Energy dashboard', { boolean: {} }],
  ['cheapest_hours', 'Cheapest hours to mark', 'In the price chart, from now to the end of the day. 0 turns it off', { number: { min: 0, max: 24, step: 1, mode: 'box' } }],
  ['house', 'House type', 'Terraced: a flat-roofed town house between grey neighbours, car parked on the street', { select: { mode: 'dropdown', options: [{ value: 'detached', label: 'Detached' }, { value: 'terraced', label: 'Terraced, in a row' }] } }],
  ['effects', 'Show seasonal effects', 'Falling leaves or snow, birds, the jogger and dog, snowman and pumpkin', { boolean: {} }],
  ['quality', 'Quality', 'Low drops shadows and sharpness, for older tablets', { select: { mode: 'dropdown', options: [{ value: 'high', label: 'High' }, { value: 'low', label: 'Low' }] } }],
  ['tap_action', 'Tap on a label', 'Default: show details and history', { ui_action: {} }],
  ['hold_action', 'Hold on a label', null, { ui_action: {} }],
];
const DEVICE_TYPE_LABELS = { heat_pump: 'Heat pump', ac: 'Air conditioning', boiler: 'Boiler', washing_machine: 'Washing machine', other: 'Other' };
for (const n of [1, 2, 3, 4]) FIELDS.push(
  [`device_${n}`, `Device ${n} power`, n === 1 ? 'A device with its own power sensor, shown as a small model in front of the house' : null, sensor],
  [`device_${n}_type`, 'Model', null, { select: { mode: 'dropdown', options: DEVICE_TYPES.map((value) => ({ value, label: DEVICE_TYPE_LABELS[value] })) } }],
  [`device_${n}_name`, 'Name', 'Empty: the sensor name', { text: {} }],
);
const FIELD = Object.fromEntries(FIELDS.map((f) => [f[0], f]));
const field = ([name, , , selector]) => ({ name, selector });
// Devices go in a collapsed section at the end, one row per device
const SCHEMA = [
  ...FIELDS.filter(([k]) => !k.startsWith('device_')).map(field),
  { type: 'expandable', name: '', title: 'Devices', icon: 'mdi:heat-pump', schema: [1, 2, 3, 4].map((n) => (
    { type: 'grid', name: '', column_min_width: '140px', schema: [`device_${n}`, `device_${n}_type`, `device_${n}_name`].map((k) => field(FIELD[k])) })) },
];

// The Energy dashboard setup, or null when it is not set up (the call then fails with not_found)
const energyPrefs = (hass) => hass.callWS({ type: 'energy/get_prefs' }).catch(() => null);

// ha-form loads lazily in Home Assistant. Opening a built-in card's editor once makes sure it is defined.
async function loadHaForm() {
  if (customElements.get('ha-form')) return;
  const helpers = await window.loadCardHelpers?.();
  const card = await helpers?.createCardElement({ type: 'entities', entities: [] });
  await card?.constructor?.getConfigElement?.();
}

class EnergySceneCardEditor extends HTMLElement {
  setConfig(config) { this.config = config; this.render(); }
  set hass(hass) { this._hass = hass; this.render(); }

  render() {
    if (!this.config || !this._hass) return;
    if (!this.form) {
      this.form = document.createElement('ha-form');
      this.form.computeLabel = (f) => FIELD[f.name]?.[1] ?? f.title;
      this.form.computeHelper = (f) => FIELD[f.name]?.[2] ?? '';
      this.form.addEventListener('value-changed', (e) => {
        this.config = fromFormData(e.detail.value, this.config);
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this.config }, bubbles: true, composed: true }));
      });
      this.append(this.form);
    }
    Object.assign(this.form, { hass: this._hass, schema: SCHEMA, data: { ...toFormData(this.config), chart: this.config.chart !== false, totals: this.config.totals !== false, effects: this.config.effects !== false } });
  }
}

if (!customElements.get('energy-scene-card')) {
  customElements.define('energy-scene-card-editor', EnergySceneCardEditor);
  customElements.define('energy-scene-card', EnergySceneCard);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'energy-scene-card',
    name: 'Energy scene',
    description: 'A 3D house showing solar, grid, home battery and EV power right now, with today\'s history.',
    documentationURL: 'https://github.com/pbrdebruijn/web-energy-sim',
  });
}
