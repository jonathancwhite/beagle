import { percentile } from './report.js';

/** @param {unknown} value @returns {string} */
function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @param {number} n @returns {string} */
function commas(n) {
  return n.toLocaleString('en-US');
}

/**
 * Round an axis maximum up to something a person would choose — 1, 2, 2.5 or
 * 5 times a power of ten. Keeps the gridlines on round numbers.
 *
 * @param {number} max
 * @returns {number}
 */
export function niceMax(max) {
  if (max <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(max));
  const scaled = max / magnitude;
  const step = [1, 2, 2.5, 5, 10].find(candidate => scaled <= candidate) ?? 10;
  return step * magnitude;
}

/**
 * Human duration for a stat tile: 840ms, 2.4s, 10.5s.
 *
 * @param {number} ms
 * @returns {string}
 */
function humanMs(ms) {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Facts about the run that are worth surfacing and can be computed. Nothing
 * here is a judgement — each one is a counted pattern, so the reader can see
 * why it was raised.
 *
 * @param {object[]} records
 * @returns {{title: string, body: string}[]}
 */
export function signals(records) {
  const out = [];
  const byRoute = new Map();

  for (const record of records) {
    const key = `${record.method} ${record.route}`;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(record);
  }

  // A wide spread on one endpoint says "unpredictable", which is a different
  // problem from "uniformly slow" and usually a more tractable one.
  const unstable = [...byRoute.entries()]
    .map(([key, group]) => {
      const durations = group.map(record => record.duration);
      const min = Math.min(...durations);
      const max = Math.max(...durations);
      return { key, n: group.length, min, max, ratio: min > 0 ? max / min : Infinity };
    })
    .filter(entry => entry.n >= 3 && entry.ratio >= 3 && entry.max >= 500)
    .sort((a, b) => b.ratio - a.ratio);

  for (const entry of unstable.slice(0, 5)) {
    out.push({
      title: `${esc(entry.key)} varies ${Math.round(entry.ratio)}×`,
      body: `${entry.n} calls, ${commas(entry.min)}ms at best and ${commas(entry.max)}ms at worst.
        An endpoint that can be fast but often isn't points at something that depends on the
        input — a filter set, a row count — rather than at steady load.`
    });
  }

  // The same call repeated on one screen is often a refetch loop.
  const byPageRoute = new Map();
  for (const record of records) {
    const key = `${record.pagePath} ${record.method} ${record.route}`;
    const entry = byPageRoute.get(key)
      ?? { page: record.pagePath, route: `${record.method} ${record.route}`, count: 0 };
    entry.count += 1;
    byPageRoute.set(key, entry);
  }

  const repeated = [...byPageRoute.values()]
    .filter(entry => entry.count >= 4)
    .sort((a, b) => b.count - a.count);

  for (const entry of repeated.slice(0, 5)) {
    out.push({
      title: `${esc(entry.route)} called ${entry.count}× on one page`,
      body: `All ${entry.count} from <code>${esc(entry.page)}</code>. Worth checking whether those are
        distinct queries or a refetch loop — a cache key changing identity on each render will do this.`
    });
  }

  // Where the time actually goes decides who fixes it.
  const withWait = records.filter(record => record.slow && record.timings.wait !== null && record.duration > 0);
  if (withWait.length) {
    const shares = withWait.map(record => (record.timings.wait / record.duration) * 100);
    const median = Math.round(percentile(shares, 50));
    out.push({
      title: `${median}% of slow-request time is server wait`,
      body: median >= 80
        ? `On the median slow request, nearly all the time is spent waiting for the first response
           byte. That is server think time — not payload size, not connection setup, not the frontend.`
        : `A meaningful share of slow-request time is <em>not</em> server wait, so payload size or
           connection setup is part of the story here, not just backend work.`
    });
  }

  return out;
}

/**
 * Render a full, self-contained report page. No external fonts, scripts or
 * images, so the file can be mailed around or opened offline.
 *
 * @param {{records: object[], rows: object[], config: object, version: string, capturedAt: string}} input
 * @returns {string}
 */
export function toHtml({ records, rows, config, version, capturedAt }) {
  const slow = records.filter(record => record.slow).sort((a, b) => b.duration - a.duration);
  const CHART_CAP = 40;
  const charted = slow.slice(0, CHART_CAP);
  const max = charted.length ? charted[0].duration : 0;
  const axisMax = niceMax(max);
  const errors = records.filter(record => record.error || (record.status && record.status >= 400)).length;

  const title = `Slow requests — ${esc(config.target ?? 'capture')}`;
  const date = new Date(capturedAt).toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' });

  const meta = [
    date,
    esc(config.target ?? 'attached tab'),
    config.resourceTypes.length ? config.resourceTypes.join(' & ') : 'all resource types',
    `threshold ${commas(config.thresholds.default)}ms`,
    `beagle v${version}`
  ];

  const tiles = [
    { value: commas(records.length), label: 'requests tracked' },
    { value: commas(slow.length), label: `over ${commas(config.thresholds.default)}ms`, alert: slow.length > 0 },
    { value: slow.length ? humanMs(slow[0].duration) : '—', label: 'slowest single call', alert: slow.length > 0 },
    { value: commas(errors), label: 'failed or 4xx/5xx', alert: errors > 0 }
  ];

  const found = signals(records);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
${STYLES}
</style>
</head>
<body>
<main>

<header>
  <h1>Slow requests</h1>
  <p class="subtitle">
    Every request over the threshold in one browsing session, and the page it was fired from.
    Timing and metadata only — no request or response bodies were read.
  </p>
  <div class="meta">${meta.map(item => `<span>${item}</span>`).join('')}</div>

  <div class="tiles">
    ${tiles.map(tile => `<div class="tile${tile.alert ? ' alert' : ''}">
      <div class="value">${tile.value}</div>
      <div class="label">${tile.label}</div>
    </div>`).join('\n    ')}
  </div>
</header>

${slow.length ? `<section>
  <h2>${commas(slow.length)} request${slow.length === 1 ? '' : 's'} over threshold</h2>
  <figure>
    <figcaption>
      Bar length is total round-trip time. Hover any row for the method, server wait, and the
      page it came from.${slow.length > CHART_CAP
        ? ` Showing the slowest ${CHART_CAP}; all ${commas(slow.length)} are in the table below.`
        : ''}
    </figcaption>

    <div class="chart">
      ${charted.map(record => `<div class="row" data-tip="${esc(record.method)} · ${
        record.timings.wait === null ? 'no timing' : `wait ${commas(record.timings.wait)}ms`
      }&#10;from ${esc(record.pagePath)}">
        <div class="name"><span class="verb">${esc(record.method)}</span> ${esc(shortPath(record.url))}</div>
        <div class="track"><div class="bar" style="width:${((record.duration / axisMax) * 100).toFixed(1)}%"></div></div>
        <div class="val">${commas(record.duration)}</div>
      </div>`).join('\n      ')}
    </div>

    <div class="axis">
      <span>0</span><span>${commas(axisMax / 4)}</span><span>${commas(axisMax / 2)}</span>
      <span>${commas((axisMax / 4) * 3)}</span><span>${commas(axisMax)} ms</span>
    </div>
  </figure>
</section>

<section>
  <h2>Full detail</h2>
  <p><strong>wait</strong> is the gap between the request leaving the browser and the first
  response byte arriving — server think time.</p>
  <div class="scroll">
    <table>
      <thead><tr>
        <th class="num">#</th><th class="num">ms</th><th class="num">wait</th>
        <th>method</th><th class="num">status</th><th>route</th><th>page</th>
      </tr></thead>
      <tbody>
        ${slow.map((record, index) => `<tr${index === 0 ? ' class="worst"' : ''}>
          <td class="num">${index + 1}</td>
          <td class="num">${commas(record.duration)}</td>
          <td class="num">${record.timings.wait === null ? '—' : commas(record.timings.wait)}</td>
          <td>${esc(record.method)}</td>
          <td class="num">${esc(record.error ?? record.status ?? '—')}</td>
          <td class="route" title="${esc(record.url)}">${esc(shortPath(record.url))}</td>
          <td class="route" title="${esc(record.page ?? record.pagePath)}">${esc(record.pagePath)}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>
  </div>
</section>` : `<section>
  <h2>Nothing over threshold</h2>
  <p>${commas(records.length)} request${records.length === 1 ? '' : 's'} tracked, none slower than
  ${commas(config.thresholds.default)}ms. The rollup below covers everything seen.</p>
</section>`}

${found.length ? `<section>
  <h2>Signals</h2>
  <p>Counted patterns, not conclusions — each one says how it was arrived at.</p>
  ${found.map(signal => `<div class="callout">
    <h3>${signal.title}</h3>
    <p>${signal.body}</p>
  </div>`).join('\n  ')}
</section>` : ''}

<section>
  <h2>Every route seen</h2>
  <p><strong>n</strong> counts every call in the session, <strong>slow</strong> those over the
  threshold. Routes are grouped by page, with id-like path segments collapsed.</p>
  <div class="scroll">
    <table>
      <thead><tr>
        <th>page</th><th>route</th>
        <th class="num">n</th><th class="num">slow</th><th class="num">err</th>
        <th class="num">p50</th><th class="num">p95</th><th class="num">max</th>
      </tr></thead>
      <tbody>
        ${rows.map(row => `<tr${row.slow > 0 ? ' class="worst"' : ''}>
          <td class="route" title="${esc(row.pagePath)}">${esc(row.pagePath)}</td>
          <td class="route" title="${esc(row.label)}">${esc(row.label)}</td>
          <td class="num">${row.count}</td>
          <td class="num">${row.slow}</td>
          <td class="num">${row.errors}</td>
          <td class="num">${commas(row.median)}</td>
          <td class="num">${commas(row.p95)}</td>
          <td class="num">${commas(row.max)}</td>
        </tr>`).join('\n        ')}
      </tbody>
    </table>
  </div>
</section>

<section>
  <h2>How to read this</h2>
  <ul>
    <li>A large <strong>wait</strong> next to a large total means the time went on the server.
      A small wait next to a large total means the payload or the connection did.</li>
    <li>Routes called once are single samples, not percentiles. Treat a lone row as a hint.</li>
    <li>The threshold is whatever was set for the run. Some endpoints legitimately need longer;
      per-route thresholds are worth setting once the obvious problems are gone.</li>
  </ul>
</section>

<footer>
  Captured ${date} with beagle v${version}${config.target ? ` against ${esc(config.target)}` : ''}.
  Timing and metadata only — no bodies read, and these headers were redacted at capture:
  ${config.redact.map(name => `<code>${esc(name)}</code>`).join(', ')}.
</footer>

</main>
</body>
</html>
`;
}

/**
 * Drop the origin from a URL for display — the host is on every row and the
 * path is what distinguishes them.
 *
 * @param {string} url
 * @returns {string}
 */
function shortPath(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

const STYLES = `  :root {
    color-scheme: light;
    --surface-1: #fcfcfb; --plane: #f9f9f7;
    --text-primary: #0b0b0b; --text-secondary: #52514e; --muted: #898781;
    --grid: #e1e0d9; --baseline: #c3c2b7; --border: rgba(11,11,11,0.10);
    --series-1: #2a78d6; --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root:where(:not([data-theme="light"])) {
      color-scheme: dark;
      --surface-1: #1a1a19; --plane: #0d0d0d;
      --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
      --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
      --series-1: #3987e5; --critical: #d03b3b;
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --surface-1: #1a1a19; --plane: #0d0d0d;
    --text-primary: #ffffff; --text-secondary: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --baseline: #383835; --border: rgba(255,255,255,0.10);
    --series-1: #3987e5; --critical: #d03b3b;
  }

  * { box-sizing: border-box; }

  body {
    margin: 0; padding: 2.5rem 1.25rem 5rem;
    background: var(--plane); color: var(--text-primary);
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 16px; line-height: 1.6;
  }
  main { max-width: 68rem; margin: 0 auto; }

  header { margin-bottom: 2.5rem; }
  h1 { font-size: 1.9rem; line-height: 1.25; margin: 0 0 .5rem; letter-spacing: -0.02em; }
  .subtitle { color: var(--text-secondary); margin: 0; max-width: 46rem; }

  .meta { display: flex; flex-wrap: wrap; gap: .4rem .75rem; margin-top: 1rem; font-size: .8rem; color: var(--muted); }
  .meta span { white-space: nowrap; }
  .meta span::after { content: '·'; margin-left: .75rem; color: var(--baseline); }
  .meta span:last-child::after { content: ''; }

  h2 { font-size: 1.1rem; margin: 3rem 0 1rem; letter-spacing: -0.01em; padding-bottom: .5rem; border-bottom: 1px solid var(--grid); }
  h3 { font-size: .95rem; margin: 0 0 .5rem; }
  p { margin: 0 0 1rem; max-width: 46rem; color: var(--text-secondary); }
  p strong, li strong { color: var(--text-primary); }

  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em;
    background: var(--surface-1); border: 1px solid var(--border);
    border-radius: 3px; padding: .05em .3em;
  }

  .tiles { display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(9.5rem, 1fr)); margin: 2rem 0 0; }
  .tile { background: var(--surface-1); border: 1px solid var(--border); border-radius: 8px; padding: 1rem 1.1rem; }
  .tile .value { font-size: 2rem; line-height: 1.1; letter-spacing: -0.03em; }
  .tile .label { font-size: .78rem; color: var(--muted); margin-top: .35rem; }
  .tile.alert .value { color: var(--critical); }

  figure { margin: 0; }
  figcaption { font-size: .8rem; color: var(--muted); margin-bottom: 1.25rem; max-width: 46rem; }

  .chart { display: flex; flex-direction: column; gap: 2px; }
  .row {
    display: grid; grid-template-columns: minmax(0, 22rem) 1fr 4.5rem;
    align-items: center; gap: .75rem; padding: .2rem .35rem;
    border-radius: 4px; position: relative;
  }
  .row:hover { background: var(--surface-1); }
  .row .name { font-size: .8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .row .name .verb { color: var(--muted); }

  .track {
    background: linear-gradient(to right, var(--grid) 1px, transparent 1px) repeat-x;
    background-size: 25% 100%;
    border-left: 1px solid var(--baseline);
    height: 15px; display: flex; align-items: center;
  }
  .bar { height: 13px; background: var(--series-1); border-radius: 0 4px 4px 0; min-width: 2px; }
  .row .val { font-size: .8rem; text-align: right; font-variant-numeric: tabular-nums; color: var(--text-secondary); }

  .row::after {
    content: attr(data-tip); position: absolute; left: 22.5rem; bottom: 100%;
    background: var(--text-primary); color: var(--surface-1);
    font-size: .72rem; line-height: 1.5; white-space: pre;
    padding: .4rem .6rem; border-radius: 6px;
    opacity: 0; pointer-events: none; transition: opacity .12s; z-index: 5;
  }
  .row:hover::after { opacity: 1; }

  .axis {
    display: flex; justify-content: space-between;
    margin-left: calc(22rem + .75rem); margin-right: 5.25rem;
    font-size: .7rem; color: var(--muted);
    border-top: 1px solid var(--baseline);
    padding-top: .3rem; margin-top: .4rem; font-variant-numeric: tabular-nums;
  }

  .scroll { overflow-x: auto; margin-bottom: 1.5rem; }
  table { border-collapse: collapse; width: 100%; font-size: .82rem; min-width: 44rem; line-height: 1.35; }
  th, td { text-align: left; padding: .4rem .6rem; border-bottom: 1px solid var(--grid); }
  th { color: var(--muted); font-weight: 600; font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Long unbroken paths would otherwise stretch the table off the page. */
  td.route {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .78rem;
    max-width: 26rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  tbody tr:hover { background: var(--surface-1); }
  .worst td { font-weight: 600; }

  ul, ol { max-width: 46rem; color: var(--text-secondary); padding-left: 1.2rem; }
  li { margin-bottom: .4rem; }

  .callout {
    background: var(--surface-1); border: 1px solid var(--border);
    border-left: 3px solid var(--series-1); border-radius: 0 8px 8px 0;
    padding: 1rem 1.2rem; margin: 1.25rem 0;
  }
  .callout p:last-child { margin-bottom: 0; }

  footer { margin-top: 4rem; padding-top: 1.25rem; border-top: 1px solid var(--grid); font-size: .78rem; color: var(--muted); }

  @media (max-width: 40rem) {
    .row { grid-template-columns: minmax(0, 9rem) 1fr 3.6rem; gap: .5rem; }
    .row .name { font-size: .7rem; }
    .row::after { left: 0; }
    .axis { margin-left: 9.5rem; margin-right: 4rem; }
  }`;
