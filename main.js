import { simulate, daylight, SAMPLE, N, DT } from './sim.js';
import { createScene, COLORS } from './scene.js';

const $ = (id) => document.getElementById(id);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const cfg = {
  yearlyKwh: 3500, month: new Date().getMonth(), kWp: 5.5, weather: 1, saldering: true, priceSrc: 'live',
  batt: { on: true, kwh: 10, kw: 5, rte: 0.85, mode: 'smart', feedEv: true },
  // Tesla Model Y Long Range: about 75 kWh usable, 16.5 kWh per 100 km in mixed driving
  ev: { on: true, kwh: 75, cons: 16.5, km: 50, from: 18, until: 7.5, chargerKw: 11, eff: 0.9, target: 80, mode: 'cheap' },
};
const get = (p) => p.split('.').reduce((o, k) => o[k], cfg);
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
    S('priceSrc', 'Day-ahead prices', [['live', 'Today, live'], ['winter', 'Sample winter day'], ['summer', 'Sample sunny summer day']]),
    C('saldering', 'Saldering, ends 1 January 2027'),
  ]],
];
const ITEMS = Object.fromEntries(SECTIONS.flatMap((s) => s[3]).map((c) => [c.p, c]));

const hhmm = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
const fmt = (c, v) => c.unit === 'h' ? hhmm(v) : `${+(v * c.k).toFixed(2)} ${c.unit}`;
const eur = (v, d = 2) => `${v < 0 ? '-' : ''}€${Math.abs(v).toFixed(d)}`;
const kwh = (v) => `${v.toFixed(1)} kWh`;
const pct = (v) => `${Math.round(v * 100)}%`;
const dot = (c) => `<i style="background:${c}"></i>`;

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
  if (p === 'priceSrc') loadPrices(); else recompute();
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

async function loadPrices() {
  priceNote = '';
  if (cfg.priceSrc === 'live') {
    try {
      const from = new Date(); from.setHours(0, 0, 0, 0);
      const till = new Date(+from + 864e5 - 1);
      const res = await fetch(`https://api.energyzero.nl/v1/energyprices?fromDate=${from.toISOString()}&tillDate=${till.toISOString()}&interval=4&usageType=1&inclBtw=false`);
      const prices = (await res.json()).Prices.map((x) => x.price);
      if (prices.length !== 24) throw new Error(`got ${prices.length} hours`);
      spot = prices;
    } catch (err) {
      console.warn('Live prices failed, using the sample winter day.', err);
      spot = SAMPLE.winter;
      priceNote = 'Live prices did not load. Showing the sample winter day.';
    }
  } else {
    spot = SAMPLE[cfg.priceSrc];
    cfg.month = cfg.priceSrc === 'summer' ? 5 : 10; // keep the sun in step with the sample prices
    sync('month');
  }
  recompute();
}

function recompute() {
  r = simulate(cfg, spot);
  version++;
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
}

// ---- Chart: three small multiples on one time axis ----
const svg = $('chart'), tip = $('tip');
const ML = 46, MR = 22;
const ROWS = [['Price you pay, € per kWh', 60], ['Power, kW. Grid below zero is export', 104], ['Charge level, %', 52]];
const CH = ROWS.reduce((a, [, h]) => a + h + 24, 0) + 16;
let PW = 0;
const xOf = (t) => ML + (t / 24) * PW;
const SERIES = () => [
  ['solar', 'Solar', r.solar, true], ['home', 'Home', r.home, true], ['ev', 'EV', r.ev, cfg.ev.on],
  ['batt', 'Battery', r.batt, false], ['grid', 'Grid', r.grid, true],
];

$('legend').innerHTML = `<span>${dot('#898781')}Price</span>` + ['solar', 'home', 'ev', 'batt', 'grid']
  .map((k) => `<span>${dot(COLORS[k])}${{ solar: 'Solar', home: 'Home use', ev: 'EV', batt: 'Home battery', grid: 'Grid' }[k]}</span>`).join('');

function drawChart() {
  const W = svg.clientWidth;
  PW = W - ML - MR;
  svg.setAttribute('height', CH);
  svg.setAttribute('viewBox', `0 0 ${W} ${CH}`);
  let y = 0, s = '';
  const row = (i, min, max, ticks, f) => {
    const [title, h] = ROWS[i], top = y + 18;
    const yOf = (v) => top + h - ((v - min) / (max - min || 1)) * h;
    s += `<text class="title" x="${ML}" y="${y + 11}">${title}</text>`;
    for (const v of ticks) s += `<line x1="${ML}" x2="${W - MR}" y1="${yOf(v)}" y2="${yOf(v)}" stroke="${v === 0 ? '#383835' : '#2c2c2a'}"/>
      <text x="${ML - 6}" y="${yOf(v) + 4}" text-anchor="end">${f(v)}</text>`;
    y = top + h + 6;
    return yOf;
  };
  const line = (data, yOf, color) => `<path fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" d="M${data.map((v, i) => `${xOf((i + 0.5) * DT).toFixed(1)},${yOf(v).toFixed(1)}`).join('L')}"/>`;

  const hourly = [...Array(24).keys()].map((h) => r.buy[h * 4]);
  const pMin = Math.min(0, ...hourly), pMax = Math.max(...hourly);
  let yOf = row(0, pMin, pMax, pMin < 0 ? [pMin, 0, pMax] : [0, pMax], (v) => v.toFixed(2));
  hourly.forEach((p, h) => {
    const a = yOf(Math.max(p, 0)), b = yOf(Math.min(p, 0));
    s += `<rect x="${xOf(h) + 1}" y="${a}" width="${PW / 24 - 2}" height="${Math.max(1, b - a)}" rx="2" fill="#898781"/>`;
  });

  const lines = SERIES().filter((x) => x[3]);
  const all = lines.flatMap((x) => x[2]);
  const kMin = Math.min(0, ...all), kMax = Math.max(1, ...all);
  yOf = row(1, kMin, kMax, kMin < -0.08 * kMax ? [kMin, 0, kMax] : [0, kMax], (v) => v.toFixed(1));
  for (const [k, , data] of lines) s += line(data, yOf, COLORS[k]);

  yOf = row(2, 0, 100, [0, 50, 100], (v) => v);
  if (cfg.batt.on) s += line(r.battSoc.map((v) => v * 100), yOf, COLORS.batt);
  if (cfg.ev.on) s += line(r.evSoc.map((v) => v * 100), yOf, COLORS.ev);

  for (let h = 0; h <= 24; h += 3) s += `<text x="${xOf(h)}" y="${y + 10}" text-anchor="middle">${hhmm(h)}</text>`;
  s += `<line id="cross" y1="0" y2="${y}" stroke="#898781" stroke-dasharray="3 3" visibility="hidden"/>
    <line id="ph" y1="0" y2="${y}" stroke="#f0efec" stroke-width="1.5"/>`;
  svg.innerHTML = s;
}

const chartT = (e) => Math.min(23.999, Math.max(0, ((e.clientX - svg.getBoundingClientRect().left - ML) / PW) * 24));
svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); t = chartT(e); });
svg.addEventListener('pointermove', (e) => {
  const ht = chartT(e), i = Math.floor(ht / DT);
  if (e.buttons) t = ht;
  const cross = $('cross');
  cross.setAttribute('x1', xOf(ht)); cross.setAttribute('x2', xOf(ht)); cross.setAttribute('visibility', 'visible');
  const line = (k, label, v) => `<div><span>${k ? dot(COLORS[k]) : ''}${label}</span><b>${v}</b></div>`;
  tip.innerHTML = `<b>${hhmm(i * DT)}</b>${line(null, 'Buy price', eur(r.buy[i], 3))}${line(null, 'Export price', eur(r.sell[i], 3))}`
    + SERIES().map(([k, label, d]) => line(k, k === 'grid' ? (d[i] < 0 ? 'Grid export' : 'Grid import') : k === 'batt' ? (d[i] < 0 ? 'Battery charging' : 'Battery output') : label, `${Math.abs(d[i]).toFixed(2)} kW`)).join('')
    + (cfg.batt.on ? line('batt', 'Battery level', pct(r.battSoc[i])) : '') + (cfg.ev.on ? line('ev', 'Car level', pct(r.evSoc[i])) : '');
  tip.style.display = 'block';
  const box = $('charts').getBoundingClientRect();
  tip.style.left = `${Math.min(e.clientX - box.left + 14, box.width - tip.offsetWidth - 8)}px`;
  tip.style.top = `${Math.max(-tip.offsetHeight + 40, e.clientY - box.top - tip.offsetHeight - 10)}px`;
});
svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; $('cross').setAttribute('visibility', 'hidden'); });
addEventListener('resize', drawChart);

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

function renderLabels(i, away) {
  const L = scene.labels, bar = (v) => `<span class="soc"><i style="width:${v * 100}%"></i></span>`;
  const kw = (v) => `${Math.abs(v).toFixed(1)} kW`;
  L.solar.innerHTML = `Solar<b>${kw(r.solar[i])}</b>`;
  L.home.innerHTML = `Home use<b>${kw(r.home[i])}</b>`;
  L.grid.innerHTML = `Grid, ${r.grid[i] < -0.03 ? 'exporting' : r.grid[i] > 0.03 ? 'importing' : 'idle'}<b>${kw(r.grid[i])}</b>${eur(r.grid[i] < 0 ? r.sell[i] : r.buy[i], 3)} per kWh`;
  L.batt.classList.toggle('off', !cfg.batt.on);
  L.ev.classList.toggle('off', !cfg.ev.on);
  if (!cfg.batt.on) L.batt.innerHTML = 'Home battery<b>Off</b>';
  else L.batt.innerHTML = `Battery, ${r.batt[i] > 0.03 ? 'discharging' : r.batt[i] < -0.03 ? 'charging' : 'idle'}<b>${kw(r.batt[i])}</b>${bar(r.battSoc[i])}${pct(r.battSoc[i])}`;
  if (!cfg.ev.on) L.ev.innerHTML = 'Model Y<b>Off</b>';
  else L.ev.innerHTML = `Model Y, ${away ? 'on the road' : r.ev[i] > 0.03 ? 'charging' : 'plugged in'}<b>${away ? pct(r.evSoc[i]) : kw(r.ev[i])}</b>${bar(r.evSoc[i])}${away ? '' : pct(r.evSoc[i])}`;
  $('now').innerHTML = `Buy ${eur(r.buy[i], 3)}<br>Export ${eur(r.sell[i], 3)}`;
}

function frame(ts) {
  const dt = Math.min(0.1, (ts - last) / 1000);
  last = ts;
  if (playing) t = (t + dt * speed * 0.4) % 24;
  const i = Math.floor(t / DT) % N, { rise, set: sunset } = daylight(cfg.month);
  const away = r.evAway[i];
  // The car takes half an hour of simulated time to pull out or roll back in.
  const evAway = away ? Math.min(1, ((t - cfg.ev.until + 24) % 24) / 0.5, ((cfg.ev.from - t + 24) % 24) / 0.5) : 0;
  const key = `${i}/${version}`;
  if (key !== labelKey) { labelKey = key; renderLabels(i, away); }
  $('time').textContent = hhmm(Math.floor(t * 12) / 12);
  const ph = $('ph');
  ph.setAttribute('x1', xOf(t)); ph.setAttribute('x2', xOf(t));
  scene.update({
    t, rise, set: sunset, weather: cfg.weather, kWp: cfg.kWp,
    solar: r.solar[i], home: r.home[i], ev: r.ev[i], batt: r.batt[i], grid: r.grid[i],
    battSoc: r.battSoc[i], battOn: cfg.batt.on, evOn: cfg.ev.on, evAway, evPlugged: !away,
  }, dt);
  requestAnimationFrame(frame);
}

recompute();
requestAnimationFrame(frame);
loadPrices();
window.sim = { setTime: (h) => { t = h; }, pause: () => { if (playing) $('play').click(); } }; // for screenshots and debugging
