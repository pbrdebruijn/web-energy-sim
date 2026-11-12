// Labels, chart and their styles, shared by the website (main.js) and the Home Assistant card (card.js).
import { COLORS } from './scene.js';
import { DT, sources } from './sim.js';

export const hhmm = (h) => `${String(Math.floor(h) % 24).padStart(2, '0')}:${String(Math.round((h % 1) * 60)).padStart(2, '0')}`;
export const eur = (v, d = 2) => `${v < 0 ? '-' : ''}€${Math.abs(v).toFixed(d)}`;
export const kwh = (v) => `${fmt.num(v, 1)} kWh`;
export const pct = (v) => `${Math.round(v * 100)}%`;
export const dot = (c) => `<i style="background:${c}"></i>`;
// For text from users or config that goes into innerHTML
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// Display language and number formats. The website keeps these English and euro defaults; the card sets them from Home Assistant.
export const fmt = { lang: 'en', money: eur, unit: '€', num: (v, d) => v.toFixed(d) };
export const tr = (s) => TEXT[fmt.lang]?.[s] ?? s;
export function setLocale(lang = 'en', currency = 'EUR') {
  try {
    const money = (d) => new Intl.NumberFormat(lang, { style: 'currency', currency, minimumFractionDigits: d, maximumFractionDigits: d });
    const unit = money(2).formatToParts(0).find((p) => p.type === 'currency')?.value ?? currency;
    Object.assign(fmt, {
      lang: lang.split('-')[0], unit,
      money: (v, d = 2) => money(d).format(v),
      num: (v, d) => new Intl.NumberFormat(lang, { minimumFractionDigits: d, maximumFractionDigits: d }).format(v),
    });
  } catch { /* unknown language or currency code: keep the defaults */ }
}

const TEXT = {
  nl: {
    Totals: 'Totalen', Solar: 'Zon', 'Home use': 'Verbruik huis', Grid: 'Net', exporting: 'teruglevering', importing: 'afname', idle: 'rust', 'per kWh': 'per kWh',
    'Home battery': 'Thuisbatterij', Off: 'Uit', Battery: 'Batterij', discharging: 'ontladen', charging: 'laden', 'on the road': 'onderweg',
    'plugged in': 'aangesloten', solar: 'zon', battery: 'batterij', grid: 'net', EV: 'Auto', Price: 'Prijs', 'Cheapest hours': 'Goedkoopste uren',
    'Negative price, you get paid': 'Negatieve prijs, je krijgt betaald', 'Solar forecast': 'Zonverwachting',
    'Price you pay, {unit} per kWh': 'Prijs die je betaalt, {unit} per kWh', 'Power, kW. Grid below zero is export': 'Vermogen, kW. Net onder nul is teruglevering',
    'Charge level, %': 'Laadniveau, %', 'Buy price': 'Inkoopprijs', 'Export price': 'Terugleverprijs', 'Grid export': 'Teruglevering',
    'Grid import': 'Afname net', 'Battery charging': 'Batterij laadt', 'Battery output': 'Batterij levert', 'Battery level': 'Batterijniveau',
    'Car level': 'Accu auto', 'No data yet': 'Nog geen gegevens', Home: 'Huis', Now: 'Nu', 'Earlier today': 'Eerder vandaag', 'Back to now': 'Terug naar nu',
    'Imported today': 'Afgenomen vandaag', 'Exported today': 'Teruggeleverd vandaag', 'Solar today': 'Zon vandaag',
    'Covered without the grid': 'Zonder net gedekt', 'Energy cost today': 'Energiekosten vandaag', 'Entity not found': 'Entiteit niet gevonden',
    'History did not load': 'Geschiedenis niet geladen', 'Show details and history': 'Details en geschiedenis tonen',
    'no grid power sensor. Pick one in the card editor, or add one to the Energy dashboard': 'geen sensor voor netvermogen. Kies er een in de kaarteditor, of voeg er een toe aan het Energie-dashboard',
  },
  de: {
    Totals: 'Summen', Solar: 'Solar', 'Home use': 'Hausverbrauch', Grid: 'Netz', exporting: 'Einspeisung', importing: 'Bezug', idle: 'Ruhe', 'per kWh': 'pro kWh',
    'Home battery': 'Hausbatterie', Off: 'Aus', Battery: 'Batterie', discharging: 'entlädt', charging: 'lädt', 'on the road': 'unterwegs',
    'plugged in': 'angesteckt', solar: 'Solar', battery: 'Batterie', grid: 'Netz', EV: 'E-Auto', Price: 'Preis', 'Cheapest hours': 'Günstigste Stunden',
    'Negative price, you get paid': 'Negativer Preis, du wirst bezahlt', 'Solar forecast': 'Solarprognose',
    'Price you pay, {unit} per kWh': 'Dein Preis, {unit} pro kWh', 'Power, kW. Grid below zero is export': 'Leistung, kW. Netz unter null ist Einspeisung',
    'Charge level, %': 'Ladestand, %', 'Buy price': 'Bezugspreis', 'Export price': 'Einspeisepreis', 'Grid export': 'Einspeisung',
    'Grid import': 'Netzbezug', 'Battery charging': 'Batterie lädt', 'Battery output': 'Batterie liefert', 'Battery level': 'Batteriestand',
    'Car level': 'Ladestand Auto', 'No data yet': 'Noch keine Daten', Home: 'Haus', Now: 'Jetzt', 'Earlier today': 'Früher heute', 'Back to now': 'Zurück zu jetzt',
    'Imported today': 'Bezogen heute', 'Exported today': 'Eingespeist heute', 'Solar today': 'Solar heute',
    'Covered without the grid': 'Ohne Netz gedeckt', 'Energy cost today': 'Energiekosten heute', 'Entity not found': 'Entität nicht gefunden',
    'History did not load': 'Verlauf nicht geladen', 'Show details and history': 'Details und Verlauf anzeigen',
    'no grid power sensor. Pick one in the card editor, or add one to the Energy dashboard': 'kein Sensor für Netzleistung. Wähle einen im Karteneditor oder füge einen im Energie-Dashboard hinzu',
  },
};

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
.tag .mix { display: block; font-size: 11px; }
.tag .soc i { display: block; height: 100%; border-radius: 2px; background: var(--c); }
.clock { position: absolute; left: 16px; bottom: 16px; z-index: 1; display: flex; gap: 10px; align-items: center; color: #f0efec;
  background: rgba(26, 26, 25, .88); border: 1px solid rgba(255, 255, 255, .1); border-radius: 10px; padding: 8px 12px; }
.clock time { font-size: 26px; font-weight: 600; font-variant-numeric: tabular-nums; }
.clock small { color: #c3c2b7; white-space: nowrap; line-height: 1.25; }
.totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; padding: 10px 14px 0; }
.totals[hidden] { display: none; }
.totals div { background: var(--tile, rgba(127, 127, 127, .12)); border-radius: 8px; padding: 6px 10px; font-size: 12px; color: var(--ink2); }
.totals b { display: block; font-size: 17px; color: var(--ink); font-variant-numeric: tabular-nums; }
.totals-btn { position: absolute; right: 12px; bottom: 12px; z-index: 1; cursor: pointer; font: inherit; font-size: 13px; color: #f0efec;
  background: rgba(26, 26, 25, .88); border: 1px solid rgba(255, 255, 255, .1); border-radius: 8px; padding: 6px 10px; }
.totals-btn[aria-pressed="true"] { border-color: #f0efec; }
.totals-btn[hidden] { display: none; }
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
// Tiles for the totals row: [[value, English label], ...], labels translated
export const totalsHtml = (items) => items.filter(Boolean).map(([v, label]) => `<div><b>${v}</b>${tr(label)}</div>`).join('');

// The "Totals" button on the scene shows or hides the totals row; the choice is remembered in this browser.
// Returns a function to call after the tiles change, so the button only shows when there are totals.
export function totalsToggle(btn, row, key, on) {
  try { const v = localStorage.getItem(key); if (v !== null) on = v === '1'; } catch { /* storage blocked: use the default */ }
  btn.textContent = tr('Totals');
  const apply = () => {
    btn.hidden = !row.innerHTML;
    row.hidden = !on || !row.innerHTML;
    btn.setAttribute('aria-pressed', String(on));
  };
  btn.onclick = () => {
    on = !on;
    try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* not remembered, still toggles */ }
    apply();
  };
  apply();
  return apply;
}

export function renderLabels(L, r, i, { batt, ev, evName: rawName = 'EV', away = false }) {
  const evName = esc(rawName); // comes from the card config, which users copy from forums
  const bar = (v) => `<span class="soc"><i style="width:${v * 100}%"></i></span>`;
  const kw = (v) => `${fmt.num(Math.abs(v ?? 0), 1)} kW`;
  const price = (r.grid[i] < 0 ? r.sell[i] : null) ?? r.buy[i];
  // "62% solar, 38% grid": where the power for the house, the car or a charging battery comes from
  const m = sources({ solar: r.solar[i] ?? 0, grid: r.grid[i] ?? 0, batt: r.batt[i] ?? 0, ev: r.ev[i] ?? 0, home: r.home[i] ?? 0 });
  const mixOf = (x) => {
    const t = (x.solar ?? 0) + (x.batt ?? 0) + (x.grid ?? 0);
    return t < 0.05 ? '' : `<span class="mix">${['solar', 'batt', 'grid'].filter((k) => (x[k] ?? 0) / t >= 0.05)
      .map((k) => `${Math.round(((x[k] ?? 0) / t) * 100)}% ${tr({ solar: 'solar', batt: 'battery', grid: 'grid' }[k])}`).join(', ')}</span>`;
  };
  L.solar.innerHTML = `${tr('Solar')}<b>${kw(r.solar[i])}</b>`;
  L.home.innerHTML = `${tr('Home use')}<b>${kw(r.home[i])}</b>${mixOf(m.home)}`;
  L.grid.innerHTML = `${tr('Grid')}, ${tr(r.grid[i] < -0.03 ? 'exporting' : r.grid[i] > 0.03 ? 'importing' : 'idle')}<b>${kw(r.grid[i])}</b>${price == null ? '' : `${fmt.money(price, 3)} ${tr('per kWh')}`}`;
  L.batt.classList.toggle('off', !batt);
  L.ev.classList.toggle('off', !ev);
  if (!batt) L.batt.innerHTML = `${tr('Home battery')}<b>${tr('Off')}</b>`;
  else L.batt.innerHTML = `${tr('Battery')}, ${tr(r.batt[i] > 0.03 ? 'discharging' : r.batt[i] < -0.03 ? 'charging' : 'idle')}<b>${kw(r.batt[i])}</b>${r.batt[i] < -0.03 ? mixOf(m.batt) : ''}${bar(r.battSoc[i] ?? 0)}${pct(r.battSoc[i] ?? 0)}`;
  if (!ev) L.ev.innerHTML = `${evName}<b>${tr('Off')}</b>`;
  else if (away) L.ev.innerHTML = `${evName}, ${tr('on the road')}<b>${r.evSoc[i] == null ? '' : pct(r.evSoc[i])}</b>${r.evSoc[i] == null ? '' : bar(r.evSoc[i])}`;
  else L.ev.innerHTML = `${evName}, ${tr(r.ev[i] > 0.03 ? 'charging' : 'plugged in')}<b>${kw(r.ev[i])}</b>${r.ev[i] > 0.03 ? mixOf(m.ev) : ''}${r.evSoc[i] == null ? '' : bar(r.evSoc[i]) + pct(r.evSoc[i])}`;
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
    const negative = show.price && r.buy.some((p) => p < 0);
    legend.innerHTML = (show.price ? `<span>${dot('#898781')}${tr('Price')}</span>` : '')
      + (show.cheap?.size ? `<span>${dot(COLORS.ev)}${tr('Cheapest hours')}</span>` : '')
      + (negative ? `<span>${dot(COLORS.home)}${tr('Negative price, you get paid')}</span>` : '')
      + ['solar', 'home', 'ev', 'batt', 'grid'].filter((k) => show[k] ?? true).map((k) => `<span>${dot(COLORS[k])}${tr(NAMES[k])}</span>`).join('')
      + (show.forecast ? `<span><i style="background:repeating-linear-gradient(90deg,${COLORS.solar} 0 3px,transparent 3px 5px)"></i>${tr('Solar forecast')}</span>` : '');
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
    const line = (data, yOf, color, dash = '') => {
      let d = '', pen = 'M';
      data.forEach((v, i) => {
        if (v == null) { pen = 'M'; return; }
        d += `${pen}${xOf((i + 0.5) * DT).toFixed(1)},${yOf(v).toFixed(1)}`;
        pen = 'L';
      });
      return d ? `<path fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" ${dash && `stroke-dasharray="${dash}"`} d="${d}"/>` : '';
    };
    const known = (a) => a.filter((v) => v != null);

    if (show.price) {
      const hourly = [...Array(24).keys()].map((h) => r.buy[h * 4]);
      const pMin = Math.min(0, ...known(hourly)), pMax = Math.max(0, ...known(hourly));
      const yOf = row(tr('Price you pay, {unit} per kWh').replace('{unit}', fmt.unit), 60, pMin, pMax, pMin < 0 ? [pMin, 0, pMax] : [0, pMax], (v) => v.toFixed(2));
      hourly.forEach((p, h) => {
        if (p == null) return;
        const a = yOf(Math.max(p, 0)), b = yOf(Math.min(p, 0));
        const fill = p < 0 ? COLORS.home : show.cheap?.has(h) ? COLORS.ev : '#898781';
        s += `<rect x="${xOf(h) + 1}" y="${a}" width="${PW / 24 - 2}" height="${Math.max(1, b - a)}" rx="2" fill="${fill}"/>`;
      });
    }

    const lines = series().filter((x) => x[3]);
    // The forecast continues the solar line from now to the end of the day
    const ahead = show.forecast && show.forecast.map((v, i) => ((i + 1) * DT > (show.now ?? 0) ? v : null));
    const all = known([...lines.flatMap((x) => x[2]), ...(ahead || [])]);
    const kMin = Math.min(0, ...all), kMax = Math.max(1, ...all);
    let yOf = row(tr('Power, kW. Grid below zero is export'), 104, kMin, kMax, kMin < -0.08 * kMax ? [kMin, 0, kMax] : [0, kMax], (v) => v.toFixed(1));
    for (const [k, , data] of lines) s += line(data, yOf, COLORS[k]);
    if (ahead) s += line(ahead, yOf, COLORS.solar, '4 3');

    if (show.batt || show.ev) {
      const pctOf = (a) => a.map((v) => (v == null ? null : v * 100));
      yOf = row(tr('Charge level, %'), 52, 0, 100, [0, 50, 100], (v) => v);
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
      r.buy[i] != null && row(null, tr('Buy price'), fmt.money(r.buy[i], 3)),
      r.sell[i] != null && row(null, tr('Export price'), fmt.money(r.sell[i], 3)),
      ...series().filter(([k, , d]) => (show[k] ?? true) && d[i] != null).map(([k, label, d]) =>
        row(k, tr(k === 'grid' ? (d[i] < 0 ? 'Grid export' : 'Grid import') : k === 'batt' ? (d[i] < 0 ? 'Battery charging' : 'Battery output') : label), `${fmt.num(Math.abs(d[i]), 2)} kW`)),
      show.batt && r.battSoc[i] != null && row('batt', tr('Battery level'), pct(r.battSoc[i])),
      show.ev && r.evSoc[i] != null && row('ev', tr('Car level'), pct(r.evSoc[i])),
    ].filter(Boolean);
    tip.innerHTML = `<b>${hhmm(i * DT)}</b>${rows.length > 0 ? rows.join('') : `<div>${tr('No data yet')}</div>`}`;
    tip.style.display = 'block';
    const b = box.getBoundingClientRect();
    tip.style.left = `${Math.min(e.clientX - b.left + 14, b.width - tip.offsetWidth - 8)}px`;
    tip.style.top = `${Math.max(-tip.offsetHeight + 40, e.clientY - b.top - tip.offsetHeight - 10)}px`;
  });
  svg.addEventListener('pointerleave', () => { tip.style.display = 'none'; q('.cross')?.setAttribute('visibility', 'hidden'); });

  return {
    draw,
    playhead(t) {
      const ph = q('.ph'), x = xOf(t).toFixed(1); // .ph is missing until the chart is first drawn
      if (ph && ph.getAttribute('x1') !== x) { ph.setAttribute('x1', x); ph.setAttribute('x2', x); } // skip repaints when it has not moved
    },
  };
}
