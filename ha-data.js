// Turns Home Assistant states and history into the day arrays the scene and chart use (the same shape simulate() returns).
// No DOM and no Three.js here, so test.js can run it in Node.
import { N, DT } from './sim.js';

export const POWER_KEYS = ['solar', 'grid', 'battery', 'ev', 'home'];
export const DEVICE_TYPES = ['heat_pump', 'ac', 'boiler', 'washing_machine', 'other'];
export const ENTITY_KEYS = [...POWER_KEYS, 'battery_soc', 'ev_soc', 'ev_plugged', 'price', 'weather'];
const SLOT_MS = DT * 3600e3;

// The card config comes from the user's YAML: fail with a message that says what to fix.
export function checkConfig(config) {
  const e = config?.entities ?? {}; // sensors left out come from the Energy dashboard
  if (typeof e !== 'object' || Array.isArray(e)) throw new Error('entities must be a list of keys and entity ids, like "grid: sensor.grid_power".');
  for (const [k, v] of Object.entries(e)) {
    if (!ENTITY_KEYS.includes(k)) throw new Error(`Unknown entities.${k}. Use: ${ENTITY_KEYS.join(', ')}.`);
    if (typeof v !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(v)) throw new Error(`entities.${k} must be an entity id like sensor.solar_power.`);
  }
  for (const k of config.invert ?? []) {
    if (!POWER_KEYS.includes(k)) throw new Error(`invert can list ${POWER_KEYS.join(', ')}, not "${k}".`);
  }
  if (config.ev_name !== undefined && typeof config.ev_name !== 'string') throw new Error('ev_name must be text.');
  if (config.devices !== undefined) {
    if (!Array.isArray(config.devices) || config.devices.length > 4) throw new Error('devices must be a list of at most 4 devices.');
    for (const d of config.devices) {
      if (typeof d?.entity !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(d.entity)) throw new Error('Each device needs "entity:" with a power sensor, like sensor.heat_pump_power.');
      if (d.type !== undefined && !DEVICE_TYPES.includes(d.type)) throw new Error(`Device type "${d.type}" is not one of ${DEVICE_TYPES.join(', ')}.`);
      if (d.name !== undefined && typeof d.name !== 'string') throw new Error('A device name must be text.');
    }
  }
  for (const k of ['height', 'solar_kwp']) {
    if (config[k] !== undefined && !(Number(config[k]) > 0)) throw new Error(`${k} must be a positive number.`);
  }
}

// A state in the card's units: kW for power (positive = solar producing, grid importing, battery discharging,
// EV charging, home using), 0..1 for charge levels, € per kWh for prices. null when unknown or unavailable.
export function toValue(key, state, unit = '', invert = false) {
  if (key === 'ev_plugged') return state === 'on' || state === 'home' ? 1 : state === 'off' || state === 'not_home' ? 0 : null;
  const v = parseFloat(state);
  if (!Number.isFinite(v)) return null;
  if (key.endsWith('_soc')) return v / 100;
  if (key === 'price') return /^(ct|c)\b|cent/i.test(unit) ? v / 100 : v;
  const kw = unit === 'W' ? v / 1000 : unit === 'MW' ? v * 1000 : v;
  return invert ? -kw : kw;
}

// Clear sky, average and cloudy, as the scene's weather factor
export const weatherFactor = (state) => ({ sunny: 1.7, 'clear-night': 1.7, partlycloudy: 1 }[state]
  ?? (['cloudy', 'fog', 'rainy', 'pouring', 'snowy', 'snowy-rainy', 'lightning', 'lightning-rainy', 'hail'].includes(state) ? 0.35 : 1));

// History rows from the history/history_during_period WebSocket call ({ s: state, lu: seconds }) as [{ t: ms, v }]
export const historyPoints = (rows = [], key, unit, invert) =>
  rows.map((p) => ({ t: (p.lu ?? p.lc) * 1000, v: toValue(key, p.s, unit, invert) }));

// Time-weighted average per 15-minute slot from start (midnight) to end (now). Each state holds until the next one.
// Slots without data stay null.
export function bucket(points, start, end) {
  const sum = new Array(N).fill(0), dur = new Array(N).fill(0);
  points.forEach((p, i) => {
    const a = Math.max(p.t, start), b = Math.min(points[i + 1]?.t ?? end, end);
    if (p.v == null || b <= a) return;
    for (let k = Math.floor((a - start) / SLOT_MS); k < N && start + k * SLOT_MS < b; k++) {
      const s0 = Math.max(a, start + k * SLOT_MS), s1 = Math.min(b, start + (k + 1) * SLOT_MS);
      sum[k] += p.v * (s1 - s0);
      dur[k] += s1 - s0;
    }
  });
  return sum.map((s, k) => (dur[k] ? s / dur[k] : null));
}

// Hourly or quarter-hourly prices for today from a sensor attribute (Nord Pool style "today: [..]"), or null
export function pricesFromAttribute(today) {
  if (!Array.isArray(today) || ![24, 96].includes(today.length) || !today.every(Number.isFinite)) return null;
  return Array.from({ length: N }, (_, i) => today[today.length === 24 ? Math.floor(i / 4) : i]);
}

// slots: { key: array of N values or nulls } for each configured entity. Missing home use follows from the balance
// solar + grid + battery = home + ev.
export function buildDay(slots) {
  const empty = new Array(N).fill(null), zero = new Array(N).fill(0);
  const s = (k, fallback) => slots[k] ?? fallback;
  const solar = s('solar', zero), grid = s('grid', empty), batt = s('battery', zero), ev = s('ev', zero);
  const home = slots.home ?? grid.map((g, i) => (g == null || solar[i] == null || batt[i] == null || ev[i] == null
    ? null : Math.max(0, solar[i] + g + batt[i] - ev[i])));
  return {
    solar, grid, batt, ev, home,
    battSoc: s('battery_soc', empty), evSoc: s('ev_soc', empty),
    buy: s('price', empty), sell: empty,
    evAway: s('ev_plugged', empty).map((v) => v === 0),
  };
}

// ---- Card editor ----
// First guess at the user's sensors when the card is added, from entity ids, names and device classes.
// Users check and correct the picks in the visual editor.
export function guessEntities(states) {
  const all = Object.entries(states).map(([entity_id, st]) => ({ ...st, entity_id })); // the map key is the entity id
  const text = (s) => `${s.entity_id} ${s.attributes?.friendly_name ?? ''}`.toLowerCase();
  const sensors = all.filter((s) => s.entity_id.startsWith('sensor.'));
  const power = sensors.filter((s) => s.attributes?.device_class === 'power' || /^(k|M)?W$/.test(s.attributes?.unit_of_measurement ?? ''));
  const level = sensors.filter((s) => s.attributes?.device_class === 'battery' || s.attributes?.unit_of_measurement === '%');
  const CAR = /\b(car|ev|tesla|vehicle|auto)\b|model.?[3ysx]\b/, GADGET = /phone|tablet|ipad|watch|remote|button|motion|door|window|temperature|leak/;
  const find = (list, want, not) => list.find((s) => want.test(text(s)) && !(not && not.test(text(s))))?.entity_id;
  const battery = find(power, /batter/, CAR);
  // Many devices report a battery level; prefer one named like the home battery's power sensor (sensor.home_battery_*)
  const battPrefix = battery?.split('.')[1].split('_')[0];
  const picks = {
    grid: find(power, /grid|net.?power|p1|electricity.?meter|power.?consumption/, /solar|batter/),
    solar: find(power, /solar|\bpv\b|inverter|photovoltaic/),
    battery,
    battery_soc: find(level, /home.?batter|batter.*(soc|state.?of.?charge)|powerwall|storage/, new RegExp(`${CAR.source}|${GADGET.source}`))
      ?? (battPrefix && find(level, new RegExp(`^sensor\\.${battPrefix}_`), new RegExp(`${CAR.source}|${GADGET.source}`))),
    ev: find(power, /charger|wallbox|charge.?point|easee|zaptec|alfen|ev.?charg/),
    ev_soc: find(level, CAR, GADGET),
    price: find(sensors, /price|tariff|nord.?pool|energyzero|zonneplan/, /gas/),
    weather: all.find((s) => s.entity_id.startsWith('weather.'))?.entity_id,
  };
  return Object.fromEntries(Object.entries(picks).filter(([, v]) => v));
}

// The editor form is flat; the card config keeps sensors under entities.
const OPTION_KEYS = ['invert', 'ev_name', 'solar_kwp', 'height', 'chart'];
export const toFormData = (config) => ({ ...config.entities, ...Object.fromEntries(OPTION_KEYS.map((k) => [k, config[k]])) });
export function fromFormData(data, config) {
  const out = { ...config, entities: {} };
  for (const k of ENTITY_KEYS) if (data[k]) out.entities[k] = data[k];
  for (const k of OPTION_KEYS) {
    const v = data[k];
    if (v === undefined || v === '' || (Array.isArray(v) && !v.length)) delete out[k];
    else out[k] = v;
  }
  return out;
}

// Power sensors the user already set up in the Energy dashboard (energy/get_prefs). Its signs match the card's:
// grid positive when importing, battery positive when discharging. External statistics ("domain:id") are not entities.
export function entitiesFromEnergyPrefs(prefs) {
  const id = (s) => (typeof s === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(s) ? s : undefined);
  const out = {};
  const put = (k, v) => { if (!out[k] && id(v)) out[k] = v; };
  for (const src of prefs?.energy_sources ?? []) {
    if (src.type === 'grid') put('grid', src.stat_rate ?? src.power?.[0]?.stat_rate); // power[] is the pre-2025 grid format
    if (src.type === 'solar') put('solar', src.stat_rate); // shortcut: first solar source only, sum several when someone asks
    if (src.type === 'battery') { put('battery', src.stat_rate); put('battery_soc', src.stat_soc); }
    if (src.type === 'home') put('home', src.stat_rate);
  }
  return out;
}

// Individual devices with a power sensor in the Energy dashboard, at most 4 (the spots in the scene)
export const devicesFromEnergyPrefs = (prefs) => (prefs?.device_consumption ?? [])
  .filter((d) => typeof d.stat_rate === 'string' && /^[a-z_]+\.[a-z0-9_]+$/.test(d.stat_rate))
  .slice(0, 4).map((d) => ({ entity: d.stat_rate, type: 'other', ...(d.name ? { name: d.name } : {}) }));
