// Turns Home Assistant states and history into the day arrays the scene and chart use (the same shape simulate() returns).
// No DOM and no Three.js here, so test.js can run it in Node.
import { N, DT } from './sim.js';

export const POWER_KEYS = ['solar', 'grid', 'battery', 'ev', 'home'];
export const ENTITY_KEYS = [...POWER_KEYS, 'battery_soc', 'ev_soc', 'ev_plugged', 'price', 'weather'];
const SLOT_MS = DT * 3600e3;

// The card config comes from the user's YAML: fail with a message that says what to fix.
export function checkConfig(config) {
  const e = config?.entities;
  if (!e || typeof e !== 'object') throw new Error('Add "entities:" with at least "grid: sensor.your_grid_power".');
  if (!e.grid) throw new Error('entities.grid is required: a power sensor, positive when importing from the grid.');
  for (const [k, v] of Object.entries(e)) {
    if (!ENTITY_KEYS.includes(k)) throw new Error(`Unknown entities.${k}. Use: ${ENTITY_KEYS.join(', ')}.`);
    if (typeof v !== 'string' || !/^[a-z_]+\.[a-z0-9_]+$/.test(v)) throw new Error(`entities.${k} must be an entity id like sensor.solar_power.`);
  }
  for (const k of config.invert ?? []) {
    if (!POWER_KEYS.includes(k)) throw new Error(`invert can list ${POWER_KEYS.join(', ')}, not "${k}".`);
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
