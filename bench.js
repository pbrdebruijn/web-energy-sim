// Performance benchmark for the energy scene card, run against card-demo.html in installed Google Chrome.
// Usage: npm run bench (after npm run build). Prints per-run numbers, medians, and a final BENCH json line.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PAGE = 'card-demo.html';
const VIEWPORT = { width: 1000, height: 900 };
const DEVICE_SCALE = 2;
const RUNS = 3;
const WARMUP_MS = 5000;
const WINDOW_MS = 20000;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};
// BENCH_GPU=1 uses the real GPU, like a tablet or Mac; the default software WebGL is slower but steadier between runs
const LAUNCHES = process.env.BENCH_GPU ? [
  { label: 'channel chrome + hardware GPU', options: { channel: 'chrome', headless: true, args: ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal'] } },
] : [
  { label: 'channel chrome + swiftshader flags', options: { channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'] } },
  { label: 'channel chrome, no args', options: { channel: 'chrome', headless: true } },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (x) => Math.round(x * 100) / 100;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

function serve() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(ROOT, urlPath);
    if (!file.startsWith(ROOT + path.sep)) return res.writeHead(403).end();
    fs.readFile(file, (err, data) => {
      if (err) return res.writeHead(404).end('not found');
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function launch() {
  const errors = [];
  for (const { label, options } of LAUNCHES) {
    try {
      return { browser: await chromium.launch(options), label };
    } catch (err) {
      errors.push(`${label}: ${err.message.split('\n')[0]}`);
    }
  }
  throw new Error('launch failed\n' + errors.join('\n'));
}

// Process CPU per process id, so each process is measured against its own start value
function cpuDelta(startInfo, endInfo) {
  const start = new Map(startInfo.map((p) => [p.id, p.cpuTime]));
  const total = { renderer: 0, gpu: 0 };
  const seen = new Set(endInfo.map((p) => p.type));
  for (const p of endInfo) {
    const key = p.type.toLowerCase();
    if (key in total) total[key] += p.cpuTime - (start.get(p.id) ?? 0);
  }
  return { ...total, seen: [...seen].sort().join(',') };
}

const metricMap = (m) => Object.fromEntries(m.metrics.map((x) => [x.name, x.value]));

async function runOnce(browser, browserCdp, url, first) {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE });
  try {
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));
    const cdp = await context.newCDPSession(page);
    await page.goto(`${url}`, { waitUntil: 'load' });
    await sleep(WARMUP_MS);
    if (pageErrors.length) throw new Error('page error: ' + pageErrors[0]);

    const info = first ? await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2');
      const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
      const cardCanvas = document.querySelector('energy-scene-card')?.shadowRoot?.querySelector('canvas');
      return { gl: gl ? (dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no webgl2', cardCanvas: !!cardCanvas };
    }) : null;

    await cdp.send('Performance.enable');
    await page.evaluate(() => {
      window.__frames = 0;
      const tick = () => { window.__frames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });

    const procStart = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
    const metStart = metricMap(await cdp.send('Performance.getMetrics'));
    const frameCount = () => page.evaluate(() => document.querySelector('energy-scene-card')?.frames ?? window.__frames);
    const framesStart = await frameCount();
    const t0 = performance.now();

    await sleep(WINDOW_MS);

    const t1 = performance.now();
    const framesEnd = await frameCount();
    const procEnd = (await browserCdp.send('SystemInfo.getProcessInfo')).processInfo;
    const metEnd = metricMap(await cdp.send('Performance.getMetrics'));
    await cdp.send('HeapProfiler.collectGarbage');
    const heapBytes = metricMap(await cdp.send('Performance.getMetrics')).JSHeapUsedSize;

    const wallS = (t1 - t0) / 1000;
    const cpu = cpuDelta(procStart, procEnd);
    const pct = (s) => (s / wallS) * 100;
    const rendererCpu = pct(cpu.renderer);
    const gpuCpu = pct(cpu.gpu);
    return {
      result: {
        rendererCpu: round(rendererCpu),
        gpuCpu: round(gpuCpu),
        totalCpu: round(rendererCpu + gpuCpu),
        taskPct: round(pct(metEnd.TaskDuration - metStart.TaskDuration)),
        scriptPct: round(pct(metEnd.ScriptDuration - metStart.ScriptDuration)),
        heapMB: round(heapBytes / 1024 / 1024),
        fps: round((framesEnd - framesStart) / wallS),
        // Software WebGL caps the frame rate, so cheaper frames show up as more fps, not less CPU; compare this instead
        cpuMsPerFrame: round(((cpu.renderer + cpu.gpu) * 1000) / (framesEnd - framesStart)),
      },
      seen: cpu.seen,
      info,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/${PAGE}`;
  const { browser, label } = await launch();
  console.log(`launch: ${label}`);
  const runs = [];
  try {
    const browserCdp = await browser.newBrowserCDPSession();
    for (let i = 1; i <= RUNS; i++) {
      const { result, seen, info } = await runOnce(browser, browserCdp, url, i === 1);
      if (info) console.log(`webgl: ${info.gl}, card canvas: ${info.cardCanvas}`);
      if (i === 1) console.log(`process types: ${seen}`);
      console.log(`run ${i}:`, JSON.stringify(result));
      runs.push(result);
    }
  } finally {
    await browser.close();
    server.close();
    server.closeAllConnections();
  }

  const keys = Object.keys(runs[0]);
  const medians = Object.fromEntries(keys.map((k) => [k, median(runs.map((r) => r[k]))]));
  console.log('median:', JSON.stringify(medians));
  console.log('BENCH ' + JSON.stringify(medians));
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
