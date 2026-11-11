// Home Assistant dashboard card: the 3D house shows what solar, grid, battery and EV do right now,
// and the chart below shows today so far. Built into dist/energy-scene-card.js by `npm run build`.
import { createScene } from './scene.js';
import { daylight, N, DT } from './sim.js';
import { createChart, renderLabels, UI_CSS, hhmm, eur } from './ui.js';
import { checkConfig, toValue, weatherFactor, historyPoints, bucket, pricesFromAttribute, buildDay, guessEntities, toFormData, fromFormData, POWER_KEYS } from './ha-data.js';

const LABEL_ENTITY = { solar: 'solar', home: 'home', grid: 'grid', batt: 'battery', ev: 'ev' };
const HISTORY_EVERY = 5 * 60e3, CHART_EVERY = 5e3, SCRUB_HOLD = 15e3;

const CARD_CSS = `
:host { display: block; --ink: var(--primary-text-color, #f0efec); --ink2: var(--secondary-text-color, #c3c2b7);
  --muted: var(--secondary-text-color, #898781); --hair: var(--divider-color, #2c2c2a); --axis: var(--divider-color, #383835); }
ha-card { overflow: hidden; }
.stage { position: relative; overflow: hidden; }
.stage canvas { display: block; }
.clock { left: 12px; bottom: 12px; padding: 6px 10px; }
.clock time { font-size: 20px; }
.charts { position: relative; padding: 10px 14px 6px; }
.warn { margin: 0; padding: 8px 14px; color: var(--error-color, #db4437); font-size: 13px; }
`;

const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const hourOf = (d) => d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;

class EnergySceneCard extends HTMLElement {
  // A new card starts with a guess at the user's sensors, to check in the editor
  static getStubConfig(hass) {
    return { entities: { grid: 'sensor.grid_power', ...(hass ? guessEntities(hass.states) : {}) } };
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
    if (!this.scene) return;
    if (!this.hist) this.loadHistory();
    this.applyLive();
  }

  getCardSize() { return Math.ceil(this.height / 50) + (this.config.chart === false ? 0 : 6); }
  getGridOptions() { return { columns: 12, min_columns: 6 }; }

  get height() { return Number(this.config.height ?? 420); }
  get entities() { return this.config.entities; }

  connectedCallback() { this.setup(); }
  disconnectedCallback() { this.teardown(); }

  setup() {
    if (this.scene || !this.config) return;
    const e = this.entities, withChart = this.config.chart !== false;
    const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${UI_CSS}${CARD_CSS}</style><ha-card>
      <div class="stage" style="height:${this.height}px"><div class="clock"><time></time><small></small></div></div>
      <p class="warn" hidden></p>
      ${withChart ? `<section class="charts"><div class="legend"></div>
        <svg class="chart" role="img" aria-label="Price, power and charge level today"></svg><div class="tip"></div></section>` : ''}
    </ha-card>`;
    const q = (s) => root.querySelector(s);
    this.q = q;
    // Fill cost scales with pixel count, and 1.5 still looks sharp at card size
    this.scene = createScene(q('.stage'), { maxPixelRatio: 1.5 });
    for (const [key, el] of Object.entries(this.scene.labels)) {
      const entityId = e[LABEL_ENTITY[key]];
      if (!entityId) continue;
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.title = 'Show details and history';
      const open = () => this.dispatchEvent(new CustomEvent('hass-more-info', { bubbles: true, composed: true, detail: { entityId } }));
      el.onclick = open;
      el.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } };
    }
    this.show = { batt: !!(e.battery || e.battery_soc), ev: !!(e.ev || e.ev_soc), price: !!e.price };
    this.chart = withChart && createChart({ svg: q('.chart'), tip: q('.tip'), legend: q('.legend'), box: q('.charts') }, (h) => {
      this.viewT = h;
      this.liveUntil = Date.now() + SCRUB_HOLD; // dragging the chart replays earlier today, then it returns to now
    });
    this.ro = new ResizeObserver(() => this.chart && this.chart.draw());
    if (withChart) this.ro.observe(q('.charts'));
    this.live = {};
    this.seen = {};
    this.weather = 1;
    this.evAnim = 0;
    this.r = buildDay({});
    this.version = 0;
    this.hist = null;
    // Only animate while the card is on screen; wall tablets keep dashboards open all day.
    this.io = new IntersectionObserver(([entry]) => { this.visible = entry.isIntersecting; if (this.visible) this.start(); });
    this.io.observe(this);
    this.timer = setInterval(() => this.loadHistory(), HISTORY_EVERY);
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
      this.histError = `History did not load: ${err.message ?? err}`;
    }
    this.applyLive(true);
  }

  // Merge the current states into today's history; the slot for "now" shows the live values.
  applyLive(force = false) {
    const hass = this._hass, e = this.entities;
    if (!hass || !this.scene) return;
    if (!force && Object.values(e).every((id) => hass.states[id] === this.seen[id])) return; // nothing of ours changed
    const invert = this.config.invert ?? [], missing = [];
    let prices = null;
    for (const [k, id] of Object.entries(e)) {
      const st = hass.states[id];
      this.seen[id] = st;
      if (!st) { missing.push(id); continue; }
      if (k === 'weather') { this.weather = weatherFactor(st.state); continue; }
      this.live[k] = toValue(k, st.state, st.attributes.unit_of_measurement, invert.includes(k));
      if (k === 'price') prices = pricesFromAttribute(st.attributes.today);
    }
    this.warn(missing.length ? `Entity not found: ${missing.join(', ')}` : this.histError ?? '');

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
      this.chart.draw(this.r, this.show);
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
    const dt = Math.min(0.1, (ts - this.last) / 1000);
    this.last = ts;
    const now = new Date();
    if (this.histDay && this.histDay !== +midnight(now)) { this.histDay = 0; this.loadHistory(); } // a new day started
    const live = !(Date.now() < this.liveUntil);
    const t = live ? hourOf(now) : this.viewT;
    const i = Math.min(N - 1, Math.floor(t / DT));
    const r = this.r, away = r.evAway[i];
    this.evAnim += ((away ? 1 : 0) - this.evAnim) * Math.min(1, dt * 1.5); // drive off and back in smoothly

    const key = `${i}/${this.version}/${live}`;
    if (key !== this.labelKey) {
      this.labelKey = key;
      renderLabels(this.scene.labels, r, i, { batt: this.show.batt, ev: this.show.ev, evName: this.config.ev_name ?? 'EV', away });
      this.q('.clock small').innerHTML = `${live ? 'Now' : 'Earlier today'}${r.buy[i] == null ? '' : `<br>${eur(r.buy[i], 3)} per kWh`}`;
    }
    this.q('.clock time').textContent = hhmm(Math.floor(t * 12) / 12);
    this.chart && this.chart.playhead(t);
    const month = now.getMonth(), { rise, set } = daylight(month);
    this.scene.update({
      t, month, rise, set, weather: this.weather, kWp: Number(this.config.solar_kwp ?? 5.5),
      solar: r.solar[i] ?? 0, home: r.home[i] ?? 0, ev: r.ev[i] ?? 0, batt: r.batt[i] ?? 0, grid: r.grid[i] ?? 0,
      battSoc: r.battSoc[i] ?? 0, battOn: this.show.batt, evOn: this.show.ev, evAway: this.evAnim, evPlugged: !away,
    }, dt);
    this.raf = requestAnimationFrame(this.frame);
  };
}

// ---- Visual editor: Home Assistant's own form with entity pickers ----
const sensor = { entity: { filter: { domain: 'sensor' } } };
const FIELDS = [
  ['grid', 'Grid power', 'Positive when importing, negative when exporting', sensor, true],
  ['solar', 'Solar power', null, sensor],
  ['battery', 'Home battery power', 'Positive when discharging into the house', sensor],
  ['battery_soc', 'Home battery level', null, sensor],
  ['ev', 'EV charger power', 'Positive when charging the car', sensor],
  ['ev_soc', 'Car battery level', null, sensor],
  ['ev_plugged', 'Car plugged in', 'On or home while the car is plugged in. Without it the car stays parked.', { entity: { filter: [{ domain: 'binary_sensor' }, { domain: 'device_tracker' }] } }],
  ['home', 'House consumption', 'Leave empty to work it out from the other sensors', sensor],
  ['price', 'Electricity price', 'In € or ct per kWh', sensor],
  ['weather', 'Weather', 'Clouds and sunshine in the scene', { entity: { filter: { domain: 'weather' } } }],
  ['invert', 'Reverse the sign of', 'Pick a sensor here when its flow runs the wrong way in the scene', {
    select: { multiple: true, mode: 'list', options: POWER_KEYS.map((k) => ({ value: k, label: { solar: 'Solar power', grid: 'Grid power', battery: 'Home battery power', ev: 'EV charger power', home: 'House consumption' }[k] })) },
  }],
  ['ev_name', 'Car name', 'Shown on the car label', { text: {} }],
  ['solar_kwp', 'Solar peak power', 'Sets how many panels the roof shows', { number: { min: 0.5, max: 30, step: 0.5, unit_of_measurement: 'kWp', mode: 'box' } }],
  ['height', 'Scene height', null, { number: { min: 200, max: 1000, step: 10, unit_of_measurement: 'px', mode: 'box' } }],
  ['chart', 'Show the chart of today', null, { boolean: {} }],
];
const SCHEMA = FIELDS.map(([name, , , selector, required]) => ({ name, selector, ...(required ? { required } : {}) }));
const FIELD = Object.fromEntries(FIELDS.map((f) => [f[0], f]));

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
      this.form.computeLabel = (f) => FIELD[f.name][1];
      this.form.computeHelper = (f) => FIELD[f.name][2] ?? '';
      this.form.addEventListener('value-changed', (e) => {
        this.config = fromFormData(e.detail.value, this.config);
        this.dispatchEvent(new CustomEvent('config-changed', { detail: { config: this.config }, bubbles: true, composed: true }));
      });
      this.append(this.form);
    }
    Object.assign(this.form, { hass: this._hass, schema: SCHEMA, data: { ...toFormData(this.config), chart: this.config.chart !== false } });
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
