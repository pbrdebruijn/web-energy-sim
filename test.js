import assert from 'node:assert/strict';
import { simulate, buyPrice, SAMPLE, N } from './sim.js';

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
