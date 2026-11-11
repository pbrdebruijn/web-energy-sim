// Labels, chart and their styles, shared by the website (main.js) and the Home Assistant card (card.js).
import { COLORS } from './scene.js';
import { DT } from './sim.js';

export const hhmm = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
export const eur = (v, d = 2) => `${v < 0 ? '-' : ''}€${Math.abs(v).toFixed(d)}`;
export const kwh = (v) => `${v.toFixed(1)} kWh`;
export const pct = (v) => `${Math.round(v * 100)}%`;
export const dot = (c) => `<i style="background:${c}"></i>`;

// Labels and tooltip sit on the 3D scene, so they keep their own dark colours in light themes too.
export const UI_CSS = `
.tag { position: absolute; left: 0; top: 0; cursor: pointer; user-select: none; white-space: nowrap; text-align: center;
  background: rgba(26, 26, 25, .88); border: 1px solid rgba(255, 255, 255, .1); border-bottom: 3px solid var(--c);
  border-radius: 8px; padding: 4px 9px; font-size: 12px; line-height: 1.4; color: #c3c2b7; }
.tag:hover, .tag:focus-visible { border-color: var(--c); outline: none; }
.tag.active { box-shadow: 0 0 0 2px var(--c); }
.tag.off { opacity: .6; }
.tag b { display: block; color: #f0efec; font-size: 14px; }
.tag .soc { display: block; height: 4px; margin-top: 3px; border-radius: 2px; background: #383835; }
.tag .soc i { display: block; height: 100%; border-radius: 2px; background: var(--c); }
.clock { position: absolute; left: 16px; bottom: 16px; z-index: 1; display: flex; gap: 10px; align-items: center; color: #f0efec;
  background: rgba(26, 26, 25, .88); border: 1px solid rgba(255, 255, 255, .1); border-radius: 10px; padding: 8px 12px; }
.clock time { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.clock small { color: #c3c2b7; white-space: nowrap; line-height: 1.25; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 16px; color: var(--ink2); font-size: 12px; margin-bottom: 4px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; }
.chart { display: block; width: 100%; cursor: crosshair; touch-action: none; }
.chart text { fill: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.chart .title { fill: var(--ink2); }
.tip { position: absolute; pointer-events: none; background: #0d0d0d; border: 1px solid #383835; border-radius: 8px;
  padding: 8px 10px; font-size: 12px; color: #c3c2b7; display: none; z-index: 2; min-width: 170px; }
.tip b { color: #f0efec; }
.tip div { display: flex; justify-content: space-between; gap: 14px; }
.tip i { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
`;

// r: the day as 15-minute arrays (see sim.js). show: { batt, ev } say which devices exist. away: the car is out driving.
export function renderLabels(L, r, i, { batt, ev, evName = 'EV', away = false }) {
  const bar = (v) => `<span class="soc"><i style="width:${v * 100}%"></i></span>`;
  const kw = (v) => `${Math.abs(v ?? 0).toFixed(1)} kW`;
  const price = (r.grid[i] < 0 ? r.sell[i] : null) ?? r.buy[i];
  L.solar.innerHTML = `Solar<b>${kw(r.solar[i])}</b>`;
  L.home.innerHTML = `Home use<b>${kw(r.home[i])}</b>`;
  L.grid.innerHTML = `Grid, ${r.grid[i] < -0.03 ? 'exporting' : r.grid[i] > 0.03 ? 'importing' : 'idle'}<b>${kw(r.grid[i])}</b>${price == null ? '' : `${eur(price, 3)} per kWh`}`;
  L.batt.classList.toggle('off', !batt);
  L.ev.classList.toggle('off', !ev);
  if (!batt) L.batt.innerHTML = 'Home battery<b>Off</b>';
  else L.batt.innerHTML = `Battery, ${r.batt[i] > 0.03 ? 'discharging' : r.batt[i] < -0.03 ? 'charging' : 'idle'}<b>${kw(r.batt[i])}</b>${bar(r.battSoc[i] ?? 0)}${pct(r.battSoc[i] ?? 0)}`;
  if (!ev) L.ev.innerHTML = `${evName}<b>Off</b>`;
  else if (away) L.ev.innerHTML = `${evName}, on the road<b>${r.evSoc[i] == null ? '' : pct(r.evSoc[i])}</b>${r.evSoc[i] == null ? '' : bar(r.evSoc[i])}`;
  else L.ev.innerHTML = `${evName}, ${r.ev[i] > 0.03 ? 'charging' : 'plugged in'}<b>${kw(r.ev[i])}</b>${r.evSoc[i] == null ? '' : bar(r.evSoc[i]) + pct(r.evSoc[i])}`;
}

// Three small multiples on one time axis: price, power and charge level. Values may be null (no data yet), which leaves a gap.
// onSeek(hour) is called while the user drags across the chart.
export function createChart({ svg, tip, legend, box }, onSeek) {
  const ML = 46, MR = 22;
  const NAMES = { solar: 'Solar', home: 'Home use', ev: 'EV', batt: 'Home battery', grid: 'Grid' };
  let r, show, PW = 0;
  const xOf = (t) => ML + (t / 24) * PW;
  const series = () => [
    ['solar', 'Solar', r.solar, true], ['home', 'Home', r.home, true], ['ev', 'EV', r.ev, show.ev],
    ['batt', 'Battery', r.batt, false], ['grid', 'Grid', r.grid, true],
  ];
  const q = (sel) => svg.querySelector(sel);

  function draw(data = r, opts = show) {
    r = data; show = { price: true, ...opts };
    if (!r) return;
    legend.innerHTML = (show.price ? `<span>${dot('#898781')}Price</span>` : '')
      + ['solar', 'home', 'ev', 'batt', 'grid'].filter((k) => show[k] ?? true).map((k) => `<span>${dot(COLORS[k])}${NAMES[k]}</span>`).join('');
    const W = svg.clientWidth;
    if (!W) return; // hidden, for example on phones until the chart is opened
    PW = W - ML - MR;
    let y = 0, s = '';
    const row = (title, h, min, max, ticks, f) => {
      const top = y + 18;
      const yOf = (v) => top + h - ((v - min) / (max - min || 1)) * h;
      s += `<text class="title" x="${ML}" y="${y + 11}">${title}</text>`;
      for (const v of ticks) s += `<line x1="${ML}" x2="${W - MR}" y1="${yOf(v)}" y2="${yOf(v)}" style="stroke:var(${v === 0 ? '--axis' : '--hair'})"/>
        <text x="${ML - 6}" y="${yOf(v) + 4}" text-anchor="end">${f(v)}</text>`;
      y = top + h + 6;
      return yOf;
    };
    const line = (data, yOf, color) => {
      let d = '', pen = 'M';
      data.forEach((v, i) => {
        if (v == null) { pen = 'M'; return; }
        d += `${pen}${xOf((i + 0.5) * DT).toFixed(1)},${yOf(v).toFixed(1)}`;
        pen = 'L';
      });
      return d ? `<path fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" d="${d}"/>` : '';
    };
    const known = (a) => a.filter((v) => v != null);

    if (show.price) {
      const hourly = [...Array(24).keys()].map((h) => r.buy[h * 4]);
      const pMin = Math.min(0, ...known(hourly)), pMax = Math.max(0, ...known(hourly));
      const yOf = row('Price you pay, € per kWh', 60, pMin, pMax, pMin < 0 ? [pMin, 0, pMax] : [0, pMax], (v) => v.toFixed(2));
      hourly.forEach((p, h) => {
        if (p == null) return;
        const a = yOf(Math.max(p, 0)), b = yOf(Math.min(p, 0));
        s += `<rect x="${xOf(h) + 1}" y="${a}" width="${PW / 24 - 2}" height="${Math.max(1, b - a)}" rx="2" fill="#898781"/>`;
      });
    }

    const lines = series().filter((x) => x[3]);
    const all = known(lines.flatMap((x) => x[2]));
    const kMin = Math.min(0, ...all), kMax = Math.max(1, ...all);
    let yOf = row('Power, kW. Grid below zero is export', 104, kMin, kMax, kMin < -0.08 * kMax ? [kMin, 0, kMax] : [0, kMax], (v) => v.toFixed(1));
    for (const [k, , data] of lines) s += line(data, yOf, COLORS[k]);

    if (show.batt || show.ev) {
      const pctOf = (a) => a.map((v) => (v == null ? null : v * 100));
      yOf = row('Charge level, %', 52, 0, 100, [0, 50, 100], (v) => v);
      if (show.batt) s += line(pctOf(r.battSoc), yOf, COLORS.batt);
      if (show.ev) s += line(pctOf(r.evSoc), yOf, COLORS.ev);
    }

    for (let h = 0; h <= 24; h += 3) s += `<text x="${xOf(h)}" y="${y + 10}" text-anchor="middle">${hhmm(h)}</text>`;
    s += `<line class="cross" y1="0" y2="${y}" stroke="#898781" stroke-dasharray="3 3" visibility="hidden"/>
      <line class="ph" y1="0" y2="${y}" style="stroke:var(--ink)" stroke-width="1.5"/>`;
    svg.setAttribute('height', y + 16);
    svg.setAttribute('viewBox', `0 0 ${W} ${y + 16}`);
    svg.innerHTML = s;
  }

  const chartT = (e) => Math.min(23.999, Math.max(0, ((e.clientX - svg.getBoundingClientRect().left - ML) / PW) * 24));
  svg.addEventListener('pointerdown', (e) => { svg.setPointerCapture(e.pointerId); onSeek(chartT(e)); });
  svg.addEventListener('pointermove', (e) => {
    if (!r || !PW) return;
    const ht = chartT(e), i = Math.floor(ht / DT);
    if (e.buttons) onSeek(ht);
    const cross = q('.cross');
    cross.setAttribute('x1', xOf(ht)); cross.setAttribute('x2', xOf(ht)); cross.setAttribute('visibility', 'visible');
    const row = (k, label, v) => `<div><span>${k ? dot(COLORS[k]) : ''}${label}</span><b>${v}</b></div>`;
    const rows = [
      r.buy[i] != null && row(null, 'Buy price', eur(r.buy[i], 3)),
      r.sell[i] != null && row(null, 'Export price', eur(r.sell[i], 3)),
      ...series().filter(([k, , d]) => (show[k] ?? true) && d[i] != null).map(([k, label, d]) =>
        row(k, k === 'grid' ? (d[i] < 0 ? 'Grid export' : 'Grid import') : k === 'batt' ? (d[i] < 0 ? 'Battery charging' : 'Battery output') : label, `${Math.abs(d[i]).toFixed(2)} kW`)),
      show.batt && r.battSoc[i] != null && row('batt', 'Battery level', pct(r.battSoc[i])),
      show.ev && r.evSoc[i] != null && row('ev', 'Car level', pct(r.evSoc[i])),
    ].filter(Boolean);
    tip.innerHTML = `<b>${hhmm(i * DT)}</b>${rows.length > 0 ? rows.join('') : '<div>No data yet</div>'}`;
    tip.style.display = 'block';
    const b = box.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - b.left + 14, b.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(-tip.offsetHeight + 40, e.clientY - b.top - tip.offsetHeight - 10)}px`;
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; q('.cross')?.setAttribute('visibility', 'hidden'); });

  return {
    draw,
    playhead(t) {
      const ph = q('.ph'); // missing until the chart is first drawn
      if (ph) { ph.setAttribute('x1', xOf(t)); ph.setAttribute('x2', xOf(t)); }
    },
  };
}
