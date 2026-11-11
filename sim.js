// Pure simulation of one day in 15 minute steps. No DOM, runs in node for test.js.

// Zonneplan dynamic tariff, all incl. VAT, 2026 values from zonneplan.nl.
export const TARIFF = { vat: 0.21, fee: 0.02, tax: 0.1108, sunBonus: 0.1 };

// Spot prices in EUR/kWh excl. VAT, 24 hourly values. Winter is the real NL day-ahead of 2026-11-10.
export const SAMPLE = {
  winter: [0.2351, 0.2284, 0.223, 0.2283, 0.2243, 0.23, 0.3152, 0.4409, 0.473, 0.4474, 0.4146, 0.389,
    0.355, 0.3584, 0.3793, 0.4164, 0.4631, 0.45, 0.4099, 0.3789, 0.3183, 0.2796, 0.252, 0.2192],
  summer: [0.09, 0.085, 0.08, 0.078, 0.08, 0.09, 0.11, 0.12, 0.09, 0.05, 0.01, -0.02,
    -0.045, -0.05, -0.03, 0, 0.04, 0.09, 0.13, 0.16, 0.15, 0.12, 0.105, 0.095],
};

export const N = 96;
export const DT = 0.25;

// Rough NL averages per month: kWh per kWp per day, and hours of daylight.
const YIELD = [0.7, 1.4, 2.6, 3.9, 4.4, 4.6, 4.5, 3.9, 2.9, 1.8, 0.8, 0.5];
const DAYLEN = [8.2, 9.9, 11.9, 13.9, 15.7, 16.7, 16.2, 14.6, 12.6, 10.6, 8.8, 7.7];
// Relative household load per hour, morning and evening peaks.
const HOME = [0.5, 0.4, 0.4, 0.4, 0.4, 0.5, 0.8, 1.2, 1.1, 0.9, 0.8, 0.8,
  0.9, 0.8, 0.8, 0.9, 1.1, 1.6, 1.9, 1.8, 1.5, 1.2, 0.9, 0.6];
const HOME_SUM = HOME.reduce((a, b) => a + b);

export const buyPrice = (spot) => spot * (1 + TARIFF.vat) + TARIFF.fee + TARIFF.tax;

// With saldering (ends 2027-01-01) export offsets import one to one. Without it you get the bare spot price.
export function sellPrice(spot, daylight, saldering) {
  const bonus = daylight && spot > 0 ? TARIFF.sunBonus * (spot * (1 + TARIFF.vat) + TARIFF.fee) : 0;
  return (saldering ? buyPrice(spot) : spot) + bonus;
}

export function daylight(month) {
  const noon = month >= 3 && month <= 9 ? 13.6 : 12.6; // summer time shifts solar noon
  return { rise: noon - DAYLEN[month] / 2, set: noon + DAYLEN[month] / 2 };
}

const tOf = (i) => (i + 0.5) * DT;

export function simulate(cfg, spot) {
  const { rise, set } = daylight(cfg.month);
  const shape = Array.from({ length: N }, (_, i) => {
    const t = tOf(i);
    return t > rise && t < set ? Math.sin((Math.PI * (t - rise)) / (set - rise)) ** 1.5 : 0;
  });
  const shapeKwh = shape.reduce((a, b) => a + b) * DT;
  const solar = shape.map((s) => (s / shapeKwh) * YIELD[cfg.month] * cfg.kWp * cfg.weather);
  const home = Array.from({ length: N }, (_, i) => {
    const t = tOf(i) - 0.5, f = t - Math.floor(t), h = Math.floor((t + 24) % 24);
    return ((HOME[h] * (1 - f) + HOME[(h + 1) % 24] * f) / HOME_SUM) * (cfg.yearlyKwh / 365) ;
  });
  const buy = solar.map((_, i) => buyPrice(spot[i >> 2]));
  const sell = solar.map((s, i) => sellPrice(spot[i >> 2], s > 0, cfg.saldering));

  const ev = cfg.ev, b = cfg.batt;
  // The car is at the charger during the slot, which may wrap past midnight. Outside it the car is on the road.
  const inSlot = (t) => ev.from <= ev.until ? t >= ev.from && t < ev.until : t >= ev.from || t < ev.until;
  const away = (i) => ev.on && !inSlot(tOf(i));
  const idx = [...Array(N).keys()];
  const awaySteps = idx.filter(away).length;
  const dailyUse = awaySteps ? (ev.km * ev.cons) / 100 : 0;
  const targetKwh = (ev.target / 100) * ev.kwh;
  const cheapSet = new Set(idx.filter((i) => !away(i)).sort((x, y) => buy[x] - buy[y])
    .slice(0, Math.ceil(dailyUse / ev.eff / (ev.chargerKw * DT))));

  // shortcut: threshold heuristic, not an optimiser. Upgrade to a proper dispatch solver if savings numbers matter.
  const nc = Math.sqrt(b.rte), nd = nc;
  const hours = [...Array(24).keys()].sort((x, y) => spot[x] - spot[y]);
  const nCharge = Math.min(8, Math.ceil(b.kwh / nc / b.kw));
  const chargeH = new Set(hours.slice(0, nCharge));
  const lowAvg = hours.slice(0, nCharge).reduce((a, h) => a + buyPrice(spot[h]), 0) / nCharge;
  const disH = new Set(hours.filter((h) => !chargeH.has(h) && buyPrice(spot[h]) * b.rte > lowAvg));

  let e = 0, c = 0, evSoc = targetKwh; // battery kWh stored, battery cost basis in EUR, car kWh
  let out;
  // Three passes so the day starts in the state it ends in.
  for (let pass = 0; pass < 3; pass++) {
    const e0 = e;
    out = { solar, home, buy, sell, ev: [], batt: [], grid: [], battSoc: [], evSoc: [], evAway: [], flows: [] };
    const T = { solar: 0, home: 0, evAc: 0, evStored: 0, evCost: 0, evSolar: 0, evGrid: 0, evBatt: 0,
      imp: 0, exp: 0, cost: 0, battIn: 0, battOut: 0 };
    for (let i = 0; i < N; i++) {
      const S = solar[i], H = home[i], hr = i >> 2;
      let E = 0;
      if (away(i)) evSoc = Math.max(0, evSoc - dailyUse / awaySteps);
      else if (ev.on) {
        const pmax = Math.min(ev.chargerKw, Math.max(0, targetKwh - evSoc) / ev.eff / DT);
        E = ev.mode === 'direct' ? pmax : ev.mode === 'cheap' ? (cheapSet.has(i) ? pmax : 0)
          : Math.min(pmax, Math.max(0, S - H));
      }
      // Solar serves home, then car, then battery, then export.
      const sH = Math.min(S, H), sE = Math.min(S - sH, E);
      const roomB = b.on ? Math.max(0, b.kwh - e) / nc / DT : 0;
      const sB = Math.min(S - sH - sE, b.kw, roomB);
      const sX = S - sH - sE - sB;
      const dH = H - sH, dE = E - sE;
      const avail = b.on && (b.mode === 'self' || disH.has(hr)) ? Math.min(b.kw, (e * nd) / DT) : 0;
      const bH = Math.min(avail, dH), bE = b.feedEv ? Math.min(avail - bH, dE) : 0;
      const gH = dH - bH, gE = dE - bE;
      const gB = b.on && b.mode === 'smart' && chargeH.has(hr) ? Math.min(b.kw - sB, roomB - sB) : 0;

      e += (sB + gB) * DT * nc;
      c += sB * DT * sell[i] + gB * DT * buy[i];
      let bCost = 0;
      if (bH + bE > 0) {
        const drawn = ((bH + bE) * DT) / nd;
        bCost = drawn * (c / e);
        c -= bCost; e -= drawn;
        if (e < 1e-9) e = c = 0;
      }
      evSoc += E * DT * ev.eff;

      const imp = gH + gE + gB;
      out.ev.push(E); out.batt.push(bH + bE - sB - gB); out.grid.push(imp - sX);
      out.battSoc.push(b.on ? e / b.kwh : 0); out.evSoc.push(evSoc / ev.kwh); out.evAway.push(away(i));
      out.flows.push({ sH, sE, sB, sX, bH, bE, gH, gE, gB });
      T.solar += S * DT; T.home += H * DT; T.evAc += E * DT; T.evStored += E * DT * ev.eff;
      T.evSolar += sE * DT; T.evGrid += gE * DT; T.evBatt += bE * DT;
      // Solar into the car costs what exporting it would have earned.
      T.evCost += sE * DT * sell[i] + gE * DT * buy[i] + (bE ? (bCost * bE) / (bH + bE) : 0);
      T.imp += imp * DT; T.exp += sX * DT; T.cost += (imp * buy[i] - sX * sell[i]) * DT;
      T.battIn += (sB + gB) * DT; T.battOut += (bH + bE) * DT;
    }
    T.battLoss = T.battIn - T.battOut - (e - e0);
    T.chargerLoss = T.evAc - T.evStored;
    T.detourLoss = T.evBatt * (1 / b.rte - 1); // extra kWh bought because car energy went through the home battery
    T.netPrice = T.evStored > 0 ? T.evCost / T.evStored : null;
    T.plugPrice = T.evAc > 0 ? T.evCost / T.evAc : null;
    T.per100 = T.netPrice === null ? null : T.netPrice * ev.cons;
    T.kmAdded = (T.evStored / ev.cons) * 100;
    T.selfUse = T.solar > 0 ? 1 - T.exp / T.solar : 0;
    T.selfSufficient = 1 - T.imp / Math.max(1e-9, T.home + T.evAc + T.battLoss);
    out.totals = T;
  }
  return out;
}

// Who supplies whom right now, in kW. Solar serves the house first, then the car, the battery and export.
// The battery serves the house, then the car, then export. The grid covers what is left.
// Returns, for each consumer (home, ev, battery charging, export), the kW it gets from solar, batt and grid.
export function sources({ solar = 0, grid = 0, batt = 0, ev = 0, home = 0 }) {
  const supply = { solar: Math.max(0, solar), batt: Math.max(0, batt), grid: Math.max(0, grid) };
  const need = { home: Math.max(0, home), ev: Math.max(0, ev), batt: Math.max(0, -batt), grid: Math.max(0, -grid) };
  const out = { home: {}, ev: {}, batt: {}, grid: {} };
  for (const s of ['solar', 'batt', 'grid']) {
    for (const d of ['home', 'ev', 'batt', 'grid']) {
      if (s === d) continue; // the battery does not charge itself, the grid does not export to itself
      const x = Math.min(supply[s], need[d]);
      out[d][s] = x;
      supply[s] -= x;
      need[d] -= x;
    }
  }
  return out;
}
