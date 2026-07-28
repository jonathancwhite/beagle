import pc from 'picocolors';

/** @param {number[]} values @param {number} p @returns {number} */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index];
}

/** @param {number} ms @param {number} threshold @returns {string} */
function colorMs(ms, threshold) {
  const text = `${ms}ms`.padStart(7);
  if (ms > threshold) return pc.red(text);
  if (ms > threshold * 0.6) return pc.yellow(text);
  return pc.green(text);
}

/**
 * One line per request, printed as it finishes.
 *
 * @param {object} record
 */
export function printRecord(record, { initiator = false } = {}) {
  const status = record.error
    ? pc.red(String(record.error).slice(0, 18).padEnd(4))
    : String(record.status ?? '---').padEnd(4);

  const marker = record.slow ? pc.red('SLOW') : pc.dim('  ok');
  const method = record.method.padEnd(6);
  const wait = record.timings.wait === null ? '' : pc.dim(` wait ${record.timings.wait}ms`);
  const cached = record.fromCache ? pc.dim(' (cache)') : '';
  const from = pc.dim(` ← ${trim(record.pagePath, 32)}`);

  console.log(
    `${marker} ${colorMs(record.duration, record.threshold)}  ${pc.dim(status)} ${method} ${trim(record.url, 66)}${wait}${cached}${from}`
  );

  if (initiator && record.initiator) {
    console.log(pc.dim(`         ${trim(record.initiator, 110)}`));
  }
}

/** @param {string} value @param {number} max @returns {string} */
function trim(value, max) {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Group finished records by route and summarise. Sorted worst-p95 first.
 *
 * @param {object[]} records
 * @returns {object[]}
 */
export function summarise(records) {
  const groups = new Map();

  for (const record of records) {
    // Keyed by page as well as route: the same endpoint called from two
    // screens is two different stories, and lumping them hides the slow one.
    const key = `${record.pagePath} ${record.method} ${record.route}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        pagePath: record.pagePath,
        method: record.method,
        route: record.route,
        durations: [],
        slow: 0,
        errors: 0,
        threshold: record.threshold
      });
    }
    const group = groups.get(key);
    group.durations.push(record.duration);
    if (record.slow) group.slow += 1;
    if (record.error || (record.status && record.status >= 400)) group.errors += 1;
  }

  return [...groups.values()]
    .map(group => ({
      key: group.key,
      pagePath: group.pagePath,
      method: group.method,
      route: group.route,
      label: `${group.method} ${group.route}`,
      threshold: group.threshold,
      count: group.durations.length,
      slow: group.slow,
      errors: group.errors,
      min: Math.min(...group.durations),
      median: percentile(group.durations, 50),
      p95: percentile(group.durations, 95),
      max: Math.max(...group.durations)
    }))
    .sort((a, b) => b.p95 - a.p95);
}

/** @param {object[]} rows */
export function printSummary(rows) {
  if (!rows.length) {
    console.log(pc.dim('\nNo matching requests were seen. Check `include` in your config.'));
    return;
  }

  const routeWidth = Math.min(52, Math.max(...rows.map(row => row.label.length), 5));
  const pageWidth = Math.min(30, Math.max(...rows.map(row => row.pagePath.length), 4));

  const head = [
    'page'.padEnd(pageWidth),
    'route'.padEnd(routeWidth),
    'n'.padStart(4),
    'p50'.padStart(7),
    'p95'.padStart(7),
    'max'.padStart(7),
    'slow'.padStart(5),
    'err'.padStart(4)
  ];

  console.log(`\n${pc.bold('Slowest routes this session')}`);
  console.log(pc.dim(head.join('  ')));

  for (const row of rows) {
    const cells = [
      trim(row.pagePath, pageWidth).padEnd(pageWidth),
      trim(row.label, routeWidth).padEnd(routeWidth),
      String(row.count).padStart(4),
      `${row.median}`.padStart(7),
      `${row.p95}`.padStart(7),
      `${row.max}`.padStart(7),
      String(row.slow).padStart(5),
      String(row.errors).padStart(4)
    ];
    const line = cells.join('  ');
    console.log(row.slow > 0 ? pc.red(line) : line);
  }

  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const slow = rows.reduce((sum, row) => sum + row.slow, 0);
  console.log(pc.dim(`\n${total} request(s) tracked, ${slow} over threshold.`));
}

/**
 * Minimal but valid HAR 1.2, so the capture can be dropped into Chrome
 * DevTools or any HAR viewer.
 *
 * @param {object[]} records
 * @returns {object}
 */
export function toHar(records) {
  return {
    log: {
      version: '1.2',
      creator: { name: 'beagle', version: '0.1.0' },
      entries: records.map(record => ({
        startedDateTime: new Date(record.startedAt).toISOString(),
        time: record.duration,
        request: {
          method: record.method,
          url: record.url,
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: toHeaderList(record.requestHeaders),
          queryString: [],
          headersSize: -1,
          bodySize: -1
        },
        response: {
          status: record.status ?? 0,
          statusText: record.error ?? '',
          httpVersion: 'HTTP/1.1',
          cookies: [],
          headers: toHeaderList(record.responseHeaders),
          content: { size: record.bytes, mimeType: record.mimeType ?? '' },
          redirectURL: '',
          headersSize: -1,
          bodySize: record.bytes
        },
        cache: {},
        timings: {
          blocked: -1,
          dns: record.timings.dns ?? -1,
          connect: record.timings.connect ?? -1,
          ssl: record.timings.tls ?? -1,
          send: record.timings.send ?? 0,
          wait: record.timings.wait ?? 0,
          receive: record.timings.download ?? 0
        },
        serverIPAddress: record.remoteAddress ?? '',
        _beagle: {
          slow: record.slow,
          threshold: record.threshold,
          route: record.route,
          page: record.page,
          initiator: record.initiator
        }
      }))
    }
  };
}

/** @param {Record<string,string>} headers */
function toHeaderList(headers = {}) {
  return Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }));
}
