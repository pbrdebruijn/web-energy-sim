import { simulate, daylight, SAMPLE, N, DT } from './sim.js';
import { createScene, COLORS } from './scene.js';
import { createChart, renderLabels, UI_CSS, hhmm, eur, kwh, pct, dot, totalsHtml, totalsToggle } from './ui.js';

document.head.append(Object.assign(document.createElement('style'), { textContent: UI_CSS }));

const $ = (id) => document.getElementById(id);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const cfg = {
  yearlyKwh: 3500, month: new Date().getMonth(), kWp: 5.5, weather: 1, saldering: true, priceSrc: 'live', provider: 'zonneplan', fee: 0.02, fixedPrice: 0.27,
  batt: { on: true, kwh: 10, kw: 5, rte: 0.85, mode: 'smart', feedEv: true },
  // Tesla Model Y Long Range: about 75 kWh usable, 16.5 kWh per 100 km in mixed driving
  ev: { on: true, kwh: 75, cons: 16.5, km: 50, from: 18, until: 7.5, chargerKw: 11, eff: 0.9, target: 80, mode: 'cheap' },
};
// Dutch dynamic suppliers. All pay the same day-ahead price plus their own purchase fee (incl. VAT, 2026).
// Live prices come from the supplier's open API, or from EnergyZero's for suppliers without one.
const PROVIDERS = {
  zonneplan: { fee: 0.02, sunBonus: 0.1, api: 'energyzero' },
  frank: { fee: 0.01815, sunBonus: 0, api: 'frank' },
  energyzero: { fee: 0.028, sunBonus: 0, api: 'energyzero' },
  fixed: { fee: 0, sunBonus: 0, api: 'energyzero' }, // spot still sets the export price without saldering
};
const get = (p, o = cfg) => p.split('.').reduce((x, k) => x[k], o);
const set = (p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], cfg)[last] = v; };

const R = (p, label, min, max, step, unit, k = 1) => ({ p, label, min, max, step, unit, k });
const S = (p, label, opts) => ({ p, label, opts });
const C = (p, label) => ({ p, label, check: true });
const A = (c) => ({ ...c, adv: true }); // advanced: starts hidden under "More settings"
const SECTIONS = [
  ['Home', 'home', null, [R('yearlyKwh', 'Yearly usage', 1000, 10000, 100, 'kWh')]],
  ['Solar panels', 'solar', null, [
    R('kWp', 'Installed power', 0, 12, 0.5, 'kWp'),
    S('month', 'Month', MONTHS.map((m, i) => [i, m])),
    A(S('weather', 'Weather', [[0.35, 'Cloudy'], [1, 'Average for the month'], [1.7, 'Clear sky']])),
  ]],
  ['Home battery', 'batt', 'batt.on', [
    R('batt.kwh', 'Capacity', 2, 30, 1, 'kWh'),
    R('batt.kw', 'Power', 1, 12, 0.5, 'kW'),
    A(R('batt.rte', 'Round trip efficiency', 60, 98, 1, '%', 100)),
    S('batt.mode', 'Strategy', [['smart', 'Trade on price: fill when cheap, use when expensive'], ['self', 'Store solar surplus only']]),
    A(C('batt.feedEv', 'Battery may charge the car')),
  ]],
  ['EV, Tesla Model Y Long Range', 'ev', 'ev.on', [
    R('ev.km', 'Driving per day', 0, 300, 5, 'km'),
    R('ev.from', 'Charging slot starts', 0, 23.75, 0.25, 'h'),
    R('ev.until', 'Charging slot ends', 0, 23.75, 0.25, 'h'),
    S('ev.mode', 'Charging strategy', [['cheap', 'Cheapest hours in the slot'], ['direct', 'Start when the slot opens'], ['solar', 'Solar surplus only']]),
    A(S('ev.chargerKw', 'Charger', [[2.3, '2.3 kW wall socket'], [3.7, '3.7 kW'], [7.4, '7.4 kW'], [11, '11 kW three phase'], [22, '22 kW']])),
    A(R('ev.eff', 'Charging efficiency, charger plus car', 75, 98, 1, '%', 100)),
    A(R('ev.target', 'Charge limit', 50, 100, 5, '%')),
    A(R('ev.kwh', 'Car battery', 40, 110, 1, 'kWh')),
    A(R('ev.cons', 'Consumption', 12, 25, 0.5, 'kWh/100 km')),
  ]],
  ['Prices', 'grid', null, [
    S('provider', 'Energy supplier', [['zonneplan', 'Zonneplan, dynamic'], ['frank', 'Frank Energie, dynamic'], ['energyzero', 'EnergyZero, dynamic'], ['fixed', 'Fixed price']]),
    R('fixedPrice', 'Fixed price, all in', 10, 60, 0.5, 'ct per kWh', 100),
    A(R('fee', 'Purchase fee on top of the day-ahead price', 0, 6, 0.05, 'ct per kWh', 100)),
    S('priceSrc', 'Day-ahead prices', [['live', 'Today, live'], ['winter', 'Sample winter day'], ['summer', 'Sample sunny summer day']]),
    C('saldering', 'Saldering, ends 1 January 2027'),
  ]],
];
const ITEMS = Object.fromEntries(SECTIONS.flatMap((s) => s[3]).map((c) => [c.p, c]));

// ---- Settings in the URL: #month=7&batt.kwh=17&ev.on=0, only what differs from the defaults ----
const DEFAULTS = structuredClone(cfg);
const SHARED = [...Object.keys(ITEMS), 'batt.on', 'ev.on'];
// month is always written: its default is the current month, which differs for whoever opens the link later
const encodeCfg = () => SHARED.filter((p) => p === 'month' || get(p) !== get(p, DEFAULTS))
  .map((p) => `${p}=${typeof get(p) === 'boolean' ? +get(p) : get(p)}`).join('&');

// The hash comes from whoever shared the link: take only known settings of the right type, clamp ranges, check choices.
function restoreCfg(hash) {
  let read;
  if (hash.startsWith('#c=')) { // older links: base64url JSON of the whole cfg
    let o;
    try { o = JSON.parse(atob(hash.slice(3).replace(/-/g, '+').replace(/_/g, '/'))); } catch { return false; }
    read = (p) => { try { return get(p, o); } catch { return undefined; } };
  } else {
    const q = new URLSearchParams(hash.slice(1));
    if (!q.size) return false;
    read = (p) => {
      const v = q.get(p), d = get(p);
      return v === null ? undefined : typeof d === 'number' ? Number(v) : typeof d === 'boolean' ? { 1: true, 0: false }[v] : v;
    };
  }
  for (const p of SHARED) {
    let v = read(p);
    const c = ITEMS[p], d = get(p);
    if (typeof v !== typeof d || (typeof v === 'number' && !Number.isFinite(v))) continue;
    if (c?.opts && !c.opts.some(([x]) => x === v)) continue;
    if (c?.min !== undefined) v = Math.min(c.max / c.k, Math.max(c.min / c.k, v));
    set(p, v);
  }
  return true;
}
const shared = restoreCfg(location.hash);

const fmt = (c, v) => c.unit === 'h' ? hhmm(v) : `${+(v * c.k).toFixed(2)} ${c.unit}`;

const control = (c) => c.check
  ? `<label class="check"><input type="checkbox" data-p="${c.p}" ${get(c.p) ? 'checked' : ''}>${c.label}</label>`
  : c.opts
    ? `<label class="row">${c.label}<select data-p="${c.p}">${c.opts.map(([v, l], i) => `<option value="${i}" ${v === get(c.p) ? 'selected' : ''}>${l}</option>`).join('')}</select></label>`
    : `<label class="row">${c.label}<output>${fmt(c, get(c.p))}</output><input type="range" data-p="${c.p}" min="${c.min}" max="${c.max}" step="${c.step}" value="${get(c.p) * c.k}"></label>`;
const head = ([title, color, toggle]) =>
  `${dot(COLORS[color])}${title}${toggle ? `<label><input type="checkbox" data-p="${toggle}" ${get(toggle) ? 'checked' : ''}> on</label>` : ''}`;
const body = (items) => {
  const adv = items.filter((c) => c.adv);
  return items.filter((c) => !c.adv).map(control).join('')
    + (adv.length ? `<details class="more"><summary>More settings</summary>${adv.map(control).join('')}</details>` : '');
};
$('controls').innerHTML = SECTIONS.map((s) => `<h2>${head(s)}</h2>${body(s[3])}`).join('');

// The sidebar and the scene popover can show the same setting, so every change refreshes all copies.
const sync = (p) => document.querySelectorAll(`[data-p="${p}"]`).forEach((el) => {
  const c = ITEMS[p], v = get(p);
  if (el.type === 'checkbox') el.checked = v;
  else if (el.tagName === 'SELECT') el.value = c.opts.findIndex(([x]) => x === v);
  else { el.value = v * c.k; el.previousElementSibling.textContent = fmt(c, v); }
});

const onInput = (e) => {
  const el = e.target, p = el.dataset.p, c = ITEMS[p];
  if (!p) return;
  if (el.type === 'checkbox') set(p, el.checked);
  else if (el.tagName === 'SELECT') set(p, c.opts[el.value][0]);
  else set(p, el.value / c.k);
  sync(p);
  if (p === 'provider') { cfg.fee = PROVIDERS[cfg.provider].fee; sync('fee'); }
  if (p === 'priceSrc' || p === 'provider') loadPrices(); else recompute();
};
$('controls').addEventListener('input', onInput);

// ---- Popover with a section's settings, opened by clicking a label in the scene ----
const pop = $('pop');
let popKey = null;
pop.addEventListener('input', onInput);
pop.addEventListener('click', (e) => { if (e.target.closest('.x')) closePop(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape' && popKey) closePop(); });

function closePop() {
  pop.hidden = true;
  scene.labels[popKey]?.classList.remove('active');
  scene.labels[popKey]?.focus();
  popKey = null;
}

function openPop(key) {
  if (popKey) { const was = popKey; closePop(); if (was === key) return; }
  const s = SECTIONS.find((x) => x[1] === key), tag = scene.labels[key];
  popKey = key;
  pop.setAttribute('aria-label', `${s[0]} settings`);
  pop.innerHTML = `<h2>${head(s)}<button class="x" aria-label="Close">✕</button></h2>${body(s[3])}`;
  pop.hidden = false;
  tag.classList.add('active');
  placePop();
  pop.querySelector('.x').focus();
}

// Below the open label, pushed up when "More settings" makes it taller; #pop max-height makes it scroll if still too tall.
function placePop() {
  const st = $('stage').getBoundingClientRect(), b = scene.labels[popKey].getBoundingClientRect();
  const clamp = (v, max) => Math.max(8, Math.min(v, max - 8));
  pop.style.left = `${clamp(b.left - st.left + b.width / 2 - pop.offsetWidth / 2, st.width - pop.offsetWidth)}px`;
  pop.style.top = `${clamp(b.bottom - st.top + 8, st.height - pop.offsetHeight)}px`;
}
pop.addEventListener('toggle', placePop, true); // details toggle does not bubble

let spot = SAMPLE.winter, priceNote = '', r, version = 0;

async function loadPrices(keepMonth = false) {
  priceNote = '';
  if (cfg.priceSrc === 'live') {
    try {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const till = new Date(+from + 864e5 - 1);
      const prices = PROVIDERS[cfg.provider].api === 'frank' ? await frankPrices(from) : await energyZeroPrices(from, till);
      if (prices.length !== 24 || !prices.every(Number.isFinite)) throw new Error(`got ${prices.length} hours`);
      spot = prices;
    } catch (err) {
      console.warn('Live prices failed, using the sample winter day.', err);
      spot = SAMPLE.winter;
      priceNote = 'Live prices did not load. Showing the sample winter day.';
    }
  } else {
    spot = SAMPLE[cfg.priceSrc];
    if (!keepMonth) { // keep the sun in step with the sample prices, unless a shared link set the month
      cfg.month = cfg.priceSrc === 'summer' ? 5 : 10;
      sync('month');
    }
  }
  recompute();
}

async function energyZeroPrices(from, till) {
  const res = await fetch(`https://api.energyzero.nl/v1/energyprices?fromDate=${from.toISOString()}&tillDate=${till.toISOString()}&interval=4&usageType=1&inclBtw=false`);
  return (await res.json()).Prices.map((x) => x.price);
}

// Frank Energie's public GraphQL API: hourly market price excl. VAT and their own purchase fee
async function frankPrices(from) {
  const day = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const res = await fetch('https://graphql.frankenergie.nl', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: `query { marketPrices(date: "${day(from)}") { electricityPrices { from marketPrice sourcingMarkupPrice } } }` }),
  });
  const list = (await res.json()).data.marketPrices.electricityPrices;
  if (Number.isFinite(list[0]?.sourcingMarkupPrice)) { cfg.fee = list[0].sourcingMarkupPrice; sync('fee'); }
  return list.map((x) => x.marketPrice);
}

function recompute() {
  const p = PROVIDERS[cfg.provider];
  r = simulate({ ...cfg, tariff: { fee: cfg.fee, sunBonus: p.sunBonus, fixed: cfg.provider === 'fixed' ? cfg.fixedPrice : null } }, spot);
  version++;
  history.replaceState(null, '', `#${encodeCfg()}`);
  renderResults();
  drawChart();
}

function renderResults() {
  const T = r.totals;
  const loss = '#6b6a65';
  const ev = !cfg.ev.on ? '' : T.netPrice === null
    ? `<div class="hero">No charging</div><p class="sub">The car draws no energy on this day. Check the driving distance, charging slot and charging strategy.</p>`
    : `<div class="hero">${eur(T.netPrice, 3)} <small>per kWh that reaches the car battery</small></div>
      <p class="sub">${eur(T.per100)} per 100 km. The energy costs ${eur(T.plugPrice, 3)} per kWh at the charger, and losses add ${pct(T.netPrice / T.plugPrice - 1)}.</p>
      <div class="bar" title="Where the energy bought for the car ends up">
        <span style="flex:${T.evStored};background:${COLORS.ev}"></span>
        <span style="flex:${T.chargerLoss};background:${loss}"></span>
        ${T.detourLoss > 0.005 ? `<span style="flex:${T.detourLoss};background:${COLORS.batt}"></span>` : ''}
      </div>
      <dl>
        <dt>${dot(COLORS.grid)}Bought from the grid</dt><dd>${kwh(T.evGrid)}</dd>
        <dt>${dot(COLORS.solar)}Taken from solar</dt><dd>${kwh(T.evSolar)}</dd>
        <dt>${dot(COLORS.batt)}Taken from the home battery</dt><dd>${kwh(T.evBatt)}</dd>
        <dt>${dot(loss)}Lost in charger and car</dt><dd>${kwh(T.chargerLoss)}</dd>
        <dt>${dot(COLORS.batt)}Lost earlier in the home battery</dt><dd>${kwh(T.detourLoss)}</dd>
        <dt>${dot(COLORS.ev)}Stored in the car</dt><dd>${kwh(T.evStored)}, ${Math.round(T.kmAdded)} km</dd>
      </dl>`;
  $('results').innerHTML = `${ev}
    <div class="tiles">
      <div><b>${eur(T.cost)}</b>Energy bill for this day</div>
      <div><b>${pct(Math.max(0, T.selfSufficient))}</b>Covered without the grid</div>
      <div><b>${kwh(T.imp)}</b>Imported</div>
      <div><b>${kwh(T.exp)}</b>Exported</div>
      <div><b>${kwh(T.solar)}</b>Solar yield, ${pct(T.selfUse)} used at home</div>
      <div><b>${kwh(T.battLoss + T.chargerLoss)}</b>Lost in battery and charger</div>
    </div>
    ${priceNote ? `<p class="note">${priceNote}</p>` : ''}`;
  // The same day totals as a row under the scene, shown with the Totals button
  $('totals').innerHTML = totalsHtml([
    [eur(T.cost), 'Energy bill for this day'], [pct(Math.max(0, T.selfSufficient)), 'Covered without the grid'],
    [kwh(T.imp), 'Imported'], [kwh(T.exp), 'Exported'], [kwh(T.solar), 'Solar yield'],
  ]);
  applyTotals();
}
const applyTotals = totalsToggle($('totalsBtn'), $('totals'), 'web-energy-sim:totals', false);

// ---- Chart ----
const chart = createChart({ svg: $('chart'), tip: $('tip'), legend: $('legend'), box: $('charts') }, (h) => { t = h; });
const drawChart = () => chart.draw(r, { batt: cfg.batt.on, ev: cfg.ev.on });
addEventListener('resize', () => chart.draw());

// ---- Phone layout: chart and settings start hidden and open from the buttons on the scene ----
const togglePanel = (name, on = !document.body.classList.contains(`show-${name}`)) => {
  document.body.classList.toggle(`show-${name}`, on);
  document.querySelector(`[data-panel=${name}]`).setAttribute('aria-expanded', on);
  if (name === 'chart' && on) chart.draw(); // the svg has no width while hidden
};
$('toggles').addEventListener('click', (e) => { const b = e.target.closest('[data-panel]'); if (b) togglePanel(b.dataset.panel); });
$('closeSettings').onclick = () => togglePanel('settings', false);

// ---- Playback and scene ----
const now = new Date();
let t = now.getHours() + now.getMinutes() / 60, playing = true, speed = 1, last = performance.now(), labelKey = '';
const scene = createScene($('stage'));
for (const [key, el] of Object.entries(scene.labels)) {
  el.tabIndex = 0;
  el.setAttribute('role', 'button');
  el.setAttribute('aria-haspopup', 'dialog');
  el.title = 'Adjust settings';
  el.onclick = () => openPop(key);
  el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPop(key); } };
}

$('play').onclick = () => {
  playing = !playing;
  $('play').textContent = playing ? '❚❚' : '▶';
  $('play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
};
$('speed').onclick = () => { speed = { 1: 4, 4: 12, 12: 1 }[speed]; $('speed').textContent = `${speed}x`; };

function frame(ts) {
  const dt = Math.min(0.1, (ts - last) / 1000);
  last = ts;
  if (playing) t = (t + dt * speed * 0.4) % 24;
  const i = Math.floor(t / DT) % N, { rise, set: sunset } = daylight(cfg.month);
  const away = r.evAway[i];
  // The car takes half an hour of simulated time to pull out or roll back in.
  const evAway = away ? Math.min(1, ((t - cfg.ev.until + 24) % 24) / 0.5, ((cfg.ev.from - t + 24) % 24) / 0.5) : 0;
  const key = `${i}/${version}`;
  if (key !== labelKey) {
    labelKey = key;
    renderLabels(scene.labels, r, i, { batt: cfg.batt.on, ev: cfg.ev.on, evName: 'Model Y', away });
    $('now').innerHTML = `Buy ${eur(r.buy[i], 3)}<br>Export ${eur(r.sell[i], 3)}`;
  }
  $('time').textContent = hhmm(Math.floor(t * 12) / 12);
  chart.playhead(t);
  scene.update({
    t, month: cfg.month, rise, set: sunset, weather: cfg.weather, kWp: cfg.kWp,
    solar: r.solar[i], home: r.home[i], ev: r.ev[i], batt: r.batt[i], grid: r.grid[i],
    battSoc: r.battSoc[i], battOn: cfg.batt.on, evOn: cfg.ev.on, evAway, evPlugged: !away,
  }, dt);
  requestAnimationFrame(frame);
}

recompute();
requestAnimationFrame(frame);
loadPrices(shared);

for (const b of document.querySelectorAll('.share')) b.onclick = async () => {
  const url = location.href, label = b.querySelector('span'), text = label.textContent;
  try {
    if (navigator.share) await navigator.share({ title: document.title, url });
    else { await navigator.clipboard.writeText(url); label.textContent = 'Link copied'; setTimeout(() => (label.textContent = text), 1500); }
  } catch (err) {
    if (err.name !== 'AbortError') prompt('Copy this link', url); // clipboard blocked: let the user copy it by hand
  }
};
window.sim = { setTime: (h) => { t = h; }, pause: () => { if (playing) $('play').click(); } }; // for screenshots and debugging
