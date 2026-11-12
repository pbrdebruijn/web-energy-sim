import assert from 'node:assert/strict';
import { simulate, buyPrice, SAMPLE, N, sources } from './sim.js';
import { bucket, toValue, checkConfig, buildDay, pricesFromAttributes, guessEntities, toFormData, fromFormData, entitiesFromEnergyPrefs, energyStatsFromPrefs, dayTotals, forecastSlots, cheapestHours, sunHours, actionFor } from './ha-data.js';

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

// Fixed price: every slot costs the same, and the home battery does not buy from the grid to trade.
const fixed = simulate({ ...base, tariff: { fixed: 0.3 } }, SAMPLE.winter);
assert.ok(fixed.buy.every((p) => p === 0.3), 'fixed buy price');
assert.ok(fixed.flows.every((f) => f.gB === 0), 'no grid charging at a flat price');
assert.ok(fixed.totals.battOut > 0, 'the battery still serves the house at a flat price');
close(simulate({ ...base, tariff: { fee: 0.05 } }, flat).buy[0] - r.buy[0], 0.03, 'purchase fee adds to the price');

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
const D0 = Date.UTC(2026, 0, 1), iso = (h) => new Date(D0 + h * 3600e3).toISOString();
assert.equal(pricesFromAttributes({ today: [1, 2] }, '€/kWh', D0), null, 'odd price lists are ignored');
assert.equal(pricesFromAttributes({ today: [...Array(24).keys()] }, '€/kWh', D0)[5], 1, 'hourly prices fill four quarters each');
close(pricesFromAttributes({ today: new Array(24).fill(25) }, 'ct/kWh', D0)[0], 0.25, 'Nord Pool in cents');
// Zonneplan hourly forecast, in 1e-7 €; also has tomorrow, which falls outside today
const zp = pricesFromAttributes({ forecast: [{ datetime: iso(0), electricity_price: 2513066 }, { datetime: iso(1), electricity_price: -100000 }, { datetime: iso(30), electricity_price: 1 }] }, '€/kWh', D0);
close(zp[0], 0.2513066, 'Zonneplan hourly price'); close(zp[4], -0.01, 'negative price'); close(zp[7], -0.01, 'an hour covers four slots');
assert.equal(zp[8], null, 'no price yet for later hours');
// Zonneplan quarter-hourly forecast
const zq = pricesFromAttributes({ forecast: [{ start_date: iso(0.25), end_date: iso(0.5), price_tax_included: { amount: 3000000 } }] }, '€/kWh', D0);
assert.deepEqual([zq[0], zq[1], zq[2]], [null, 0.3, null], 'Zonneplan quarter-hour price');
close(pricesFromAttributes({ raw_today: [{ start: iso(2), end: iso(3), value: 0.12 }] }, '€/kWh', D0)[9], 0.12, 'Nord Pool raw_today');

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
const withDevices = { entities: {}, devices: [{ entity: 'sensor.hp_power', type: 'heat_pump', name: 'Warmtepomp' }, { entity: 'sensor.wm_power', type: 'other' }] };
assert.deepEqual(fromFormData(toFormData(withDevices), withDevices), withDevices, 'devices survive the editor');
assert.deepEqual(fromFormData({ device_2: 'sensor.ac_power' }, {}).devices, [{ entity: 'sensor.ac_power', type: 'other' }], 'empty slots are skipped');
assert.equal(fromFormData({}, withDevices).devices, undefined, 'clearing every slot removes devices');
checkConfig({ devices: [{ entity: 'sensor.hp_power', type: 'heat_pump', name: 'Warmtepomp' }] });
assert.throws(() => checkConfig({ devices: [{ entity: 'sensor.x', type: 'rocket' }] }), /not one of/);
assert.throws(() => checkConfig({ devices: [{ type: 'ac' }] }), /entity/);

// Today's totals: kWh meters per kind, then the share covered without the grid
const stats = energyStatsFromPrefs({ energy_sources: [
  { type: 'grid', flow_from: [{ stat_energy_from: 'sensor.t1', stat_cost: 'sensor.t1_cost' }, { stat_energy_from: 'sensor.t2' }], flow_to: [{ stat_energy_to: 'sensor.out' }] },
  { type: 'solar', stat_energy_from: 'sensor.pv' }, { type: 'battery', stat_energy_from: 'sensor.b_out', stat_energy_to: 'sensor.b_in' },
] });
assert.deepEqual([stats.grid_in, stats.grid_out, stats.cost, stats.batt_in], [['sensor.t1', 'sensor.t2'], ['sensor.out'], ['sensor.t1_cost'], ['sensor.b_in']], 'energy meters per kind');
const tot = dayTotals({ grid_in: 2, grid_out: 3, solar: 10, batt_out: 1, batt_in: 2, cost: 0.6, compensation: 0.2 }, true);
close(tot.used, 8, 'used = 2 + 10 + 1 - 3 - 2');
close(tot.selfSufficient, 0.75, 'covered without the grid = 1 - 2/8');
close(tot.cost, 0.4, 'cost minus compensation');
assert.equal(dayTotals({}, false).selfSufficient, null, 'no use, no share');
close(dayTotals({ grid_in: 10, batt_in: 6, batt_out: 5, solar: 0 }, false).selfSufficient, 5 / 9, 'night-charged battery: only the 4 kWh that went straight to the house count as grid use');

// Solar forecast: hourly Wh becomes kW per quarter, summed over forecast entries
const day0 = Date.UTC(2026, 5, 1);
const fc = forecastSlots({
  a: { wh_hours: { [new Date(day0 + 12 * 3600e3).toISOString()]: 2000, [new Date(day0 + 13 * 3600e3).toISOString()]: 1000 } },
  b: { wh_hours: { [new Date(day0 + 12 * 3600e3).toISOString()]: 500 } },
}, day0);
assert.deepEqual([fc[47], fc[48], fc[51], fc[52], fc[56]], [0, 2.5, 2.5, 1, 0], 'forecast slots');
assert.equal(forecastSlots({}, day0), null, 'no forecast');
const prices = Array.from({ length: N }, (_, i) => [5, 1, 3, 2][Math.floor(i / 4) % 4]);
assert.deepEqual([...cheapestHours(prices, 2.5, 3)].sort((a, b) => a - b), [5, 9, 13], 'cheapest hours still to come, earliest first on ties');
assert.ok(!cheapestHours(prices, 2.5, 24).has(1), 'past hours are not offered');

// Sunrise and sunset come from sun.sun in local time
const at = (h, m) => new Date(2026, 5, 2, h, m).toISOString();
assert.deepEqual(sunHours({ attributes: { next_rising: at(5, 15), next_setting: at(22, 0) } }), { rise: 5.25, set: 22 }, 'sun hours');
assert.equal(sunHours(undefined), null, 'no sun.sun');

// Tap and hold: per-label action first, then the card-wide one, else the default (null)
const acfg = { tap_action: { action: 'navigate', navigation_path: '/energy' }, actions: { ev: { tap_action: { action: 'toggle' } } } };
assert.equal(actionFor(acfg, 'ev', 'tap').action, 'toggle', 'per-label action');
assert.equal(actionFor(acfg, 'grid', 'tap').action, 'navigate', 'card-wide action');
assert.equal(actionFor(acfg, 'grid', 'hold'), null, 'default');
checkConfig({ quality: 'low', ...acfg });
assert.throws(() => checkConfig({ actions: { roof: { tap_action: { action: 'none' } } } }), /actions can set/);
assert.throws(() => checkConfig({ tap_action: 'more-info' }), /need an "action:"/);

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
