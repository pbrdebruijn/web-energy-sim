import assert from 'node:assert/strict';
import { simulate, buyPrice, SAMPLE, N, sources } from './sim.js';
import { bucket, toValue, checkConfig, buildDay, pricesFromAttribute, guessEntities, toFormData, fromFormData, entitiesFromEnergyPrefs } from './ha-data.js';

const base = {
  yearlyKwh: 3500, month: 5, kWp: 6, weather: 1, saldering: true,
  batt: { on: true, kwh: 10, kw: 5, rte: 0.85, mode: 'smart', feedEv: true },
  ev: { on: true, kwh: 75, cons: 16.5, km: 50, from: 18, until: 7.5, chargerKw: 11, eff: 0.9, target: 80, mode: 'direct' },
};
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} vs ${b}`);

// Energy balance holds in every step, for every mode combination.
for (const spot of Object.values(SAMPLE))
  for (const bm of ['smart', 'self'])
    for (const em of ['direct', 'cheap', 'solar']) {
      const cfg = { ...base, batt: { ...base.batt, mode: bm }, ev: { ...base.ev, mode: em } };
      const r = simulate(cfg, spot);
      for (let i = 0; i < N; i++)
        close(r.solar[i] + r.grid[i] + r.batt[i], r.home[i] + r.ev[i], `balance ${bm}/${em} step ${i}`);
      assert.ok(r.battSoc.every((s) => s >= -1e-9 && s <= 1 + 1e-9), 'battery soc in range');
      assert.ok(r.totals.battLoss >= -1e-6, 'battery never creates energy');
    }

// Flat price, no solar, no battery: net price is grid price divided by charger efficiency.
const flat = Array(24).fill(0.1);
const r = simulate({ ...base, kWp: 0, batt: { ...base.batt, on: false } }, flat);
close(r.totals.netPrice, buyPrice(0.1) / 0.9, 'net price, grid only');
close(r.totals.evStored, 50 * 0.165, 'daily driving gets recharged');

// Same day, but the car charges only through the home battery: both losses stack.
const viaBatt = simulate({ ...base, kWp: 0, batt: { ...base.batt, mode: 'self', on: true } }, flat);
assert.equal(viaBatt.totals.evBatt, 0, 'self mode with no solar leaves the battery empty');

// Cheap mode never pays more than direct mode.
const direct = simulate({ ...base, kWp: 0, batt: { ...base.batt, on: false } }, SAMPLE.winter);
const cheap = simulate({ ...base, kWp: 0, batt: { ...base.batt, on: false }, ev: { ...base.ev, mode: 'cheap' } }, SAMPLE.winter);
assert.ok(cheap.totals.netPrice < direct.totals.netPrice, 'cheap hours beat plug-in charging');

console.log('ok', { direct: direct.totals.netPrice.toFixed(3), cheap: cheap.totals.netPrice.toFixed(3) });

// An afternoon slot charges only inside the slot.
const noon = simulate({ ...base, ev: { ...base.ev, from: 12, until: 16, mode: 'cheap' } }, SAMPLE.summer);
assert.ok(noon.ev.every((p, i) => p === 0 || (i >= 48 && i < 64)), 'charging stays inside the afternoon slot');
close(noon.totals.evStored, 50 * 0.165, 'afternoon slot recharges the daily driving');

// ---- Home Assistant card data ----
// Each state holds until the next one; a slot averages them by time. Slots after "now" stay empty.
const H = 3600e3, start = Date.UTC(2026, 0, 1);
const b = bucket([{ t: start - H, v: 2 }, { t: start + 0.1 * H, v: 4 }, { t: start + 0.2 * H, v: null }, { t: start + 0.5 * H, v: 1 }], start, start + 0.6 * H);
close(b[0], (2 * 0.1 + 4 * 0.1) / 0.2, 'first slot averages the two known states, the unavailable stretch is left out');
assert.equal(b[1], null, 'slot with only an unavailable state is empty');
close(b[2], 1, 'state carries on into the next slot');
assert.equal(b[3], null, 'slots after now are empty');

close(toValue('solar', '2500', 'W'), 2.5, 'W becomes kW');
close(toValue('battery', '1.2', 'kW', true), -1.2, 'invert flips the sign');
close(toValue('battery_soc', '80', '%'), 0.8, 'charge level becomes 0..1');
close(toValue('price', '25.1', 'ct/kWh'), 0.251, 'cents become euros');
assert.equal(toValue('grid', 'unavailable', 'kW'), null, 'unavailable is unknown, not zero');
assert.equal(toValue('ev_plugged', 'off'), 0, 'unplugged');

checkConfig({}); // all sensors may come from the Energy dashboard
assert.throws(() => checkConfig({ entities: ['sensor.a'] }), /entities must be/);
assert.throws(() => checkConfig({ entities: { grid: 'sensor.a', sun: 'sensor.b' } }), /Unknown entities.sun/);
assert.throws(() => checkConfig({ entities: { grid: 'not an id' } }), /entity id/);
assert.throws(() => checkConfig({ entities: { grid: 'sensor.a' }, invert: ['price'] }), /invert/);
checkConfig({ entities: { grid: 'sensor.a', battery: 'sensor.b' }, invert: ['battery'], height: 400 });

const fill = (v) => new Array(N).fill(v);
const day = buildDay({ solar: fill(3), grid: fill(-1), battery: fill(-0.5), ev: fill(1) });
close(day.home[0], 0.5, 'home use follows from the balance: 3 - 1 - 0.5 - 1');
assert.equal(day.evAway[0], false, 'without a plugged-in sensor the car stays home');
assert.equal(pricesFromAttribute([1, 2]), null, 'odd price lists are ignored');
assert.equal(pricesFromAttribute([...Array(24).keys()])[5], 1, 'hourly prices fill four quarters each');

// The first guess at sensors picks the right ones out of a typical mix, and skips phones and the car for the home battery.
const st = (id, device_class, unit, name = '') => ({ entity_id: id, attributes: { device_class, unit_of_measurement: unit, friendly_name: name } });
const guess = guessEntities(Object.fromEntries([
  st('sensor.p1_meter_active_power', 'power', 'W', 'P1 Meter Active power'),
  st('sensor.solaredge_ac_power', 'power', 'W', 'SolarEdge AC power'),
  st('sensor.iphone_battery_level', 'battery', '%', 'iPhone Battery Level'),
  st('sensor.model_y_battery_level', 'battery', '%', 'Model Y Battery level'),
  st('sensor.home_battery_soc', 'battery', '%', 'Home battery SoC'),
  st('sensor.home_battery_power', 'power', 'kW', 'Home battery power'),
  st('sensor.easee_power', 'power', 'kW', 'Easee charger power'),
  st('sensor.gas_price', null, '€/m³', 'Gas price'),
  st('sensor.current_electricity_price', null, '€/kWh', 'Electricity price'),
  { entity_id: 'weather.home', attributes: {} },
].map((x) => [x.entity_id, x])));
assert.deepEqual(guess, {
  grid: 'sensor.p1_meter_active_power', solar: 'sensor.solaredge_ac_power', battery: 'sensor.home_battery_power',
  battery_soc: 'sensor.home_battery_soc', ev: 'sensor.easee_power', ev_soc: 'sensor.model_y_battery_level',
  price: 'sensor.current_electricity_price', weather: 'weather.home',
}, 'sensor guesses');

// Editor round trip: flat form data back to entities, empty values dropped
const cfg0 = { type: 'custom:energy-scene-card', entities: { grid: 'sensor.g', solar: 'sensor.s' }, invert: ['grid'], height: 400 };
assert.deepEqual(fromFormData(toFormData(cfg0), cfg0), cfg0, 'round trip keeps the config');
assert.deepEqual(fromFormData({ grid: 'sensor.g', solar: '', invert: [] }, cfg0),
  { type: 'custom:energy-scene-card', entities: { grid: 'sensor.g' } }, 'cleared fields leave the config');
const guess2 = guessEntities(Object.fromEntries([
  st('sensor.hallway_motion_battery', 'battery', '%'), st('sensor.battery_power', 'power', 'kW'), st('sensor.battery_level', null, '%'),
].map((x) => [x.entity_id, x])));
assert.equal(guess2.battery_soc, 'sensor.battery_level', 'battery level found by the power sensor name, not a motion sensor');
// Energy dashboard power sensors become the card's entities; external statistics and energy-only sources are skipped
assert.deepEqual(entitiesFromEnergyPrefs({ energy_sources: [
  { type: 'grid', stat_energy_from: 'sensor.grid_in', stat_rate: 'sensor.grid_power' },
  { type: 'solar', stat_energy_from: 'sensor.pv_energy', stat_rate: 'sensor.pv_power' },
  { type: 'solar', stat_energy_from: 'sensor.pv2_energy', stat_rate: 'sensor.pv2_power' },
  { type: 'battery', stat_energy_from: 'a', stat_energy_to: 'b', stat_rate: 'tesla:battery_power', stat_soc: 'sensor.batt_soc' },
] }), { grid: 'sensor.grid_power', solar: 'sensor.pv_power', battery_soc: 'sensor.batt_soc' }, 'energy dashboard sensors');
assert.deepEqual(entitiesFromEnergyPrefs({ energy_sources: [{ type: 'grid', flow_from: [], power: [{ stat_rate: 'sensor.p1' }] }] }), { grid: 'sensor.p1' }, 'pre-2025 grid format');
assert.deepEqual(entitiesFromEnergyPrefs(null), {}, 'no Energy dashboard');

// The car name from the config is text, never markup
const { renderLabels } = await import('./ui.js');
const tag = () => ({ innerHTML: '', classList: { toggle() {} } });
const L = { solar: tag(), home: tag(), grid: tag(), batt: tag(), ev: tag() };
renderLabels(L, buildDay({ grid: fill(1) }), 0, { batt: false, ev: true, evName: '<img src=x onerror=alert(1)>' });
assert.ok(!L.ev.innerHTML.includes('<img') && L.ev.innerHTML.includes('&#60;img'), 'ev_name is escaped');
assert.throws(() => checkConfig({ entities: { grid: 'sensor.a' }, ev_name: { x: 1 } }), /ev_name/);
// Solar serves the house first, then the car, the battery and export; the grid covers the rest
const mix = sources({ solar: 3, grid: -0.5, batt: -1, ev: 1, home: 0.5 });
assert.deepEqual([mix.home.solar, mix.ev.solar, mix.batt.solar, mix.grid.solar], [0.5, 1, 1, 0.5], 'solar split over all users');
const night = sources({ solar: 0, grid: 4, batt: 1, ev: 4, home: 1 });
assert.deepEqual([night.home.batt, night.ev.grid, night.home.grid], [1, 4, 0], 'battery covers the house, the grid the car');
console.log('ok card data');
