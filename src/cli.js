import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import pc from 'picocolors';

import { loadConfig } from './config.js';
import { Collector } from './collector.js';
import { openChrome, attachCollector } from './browser.js';
import { printRecord, printSummary, summarise, toHar } from './report.js';
import { toHtml } from './html.js';

const { version } = createRequire(import.meta.url)('../package.json');

const HELP = `
${pc.bold('beagle')} — sniff out slow HTTP requests in a running web app

  ${pc.dim('$')} npx @jonathancwhite/beagle http://localhost:3000

Options
  -c, --config <path>    config file (default: nearest beagle.config.js)
  -t, --threshold <ms>   flag anything slower than this (default: 800)
  -i, --include <glob>   only track URLs matching this; repeatable
      --ignore <glob>    drop URLs matching this; repeatable
      --types <list>     CDP resource types (default: XHR,Fetch; "all" for everything)
  -p, --port <n>         attach to a Chrome already running with --remote-debugging-port
      --headless         launch Chrome headless
  -d, --duration <s>     stop and report after this many seconds
  -a, --all              print every request, not just the slow ones
      --initiator        also print the code that fired each request
      --html <path>      where to write the HTML report (default: beagle-report.html)
      --no-html          skip the HTML report
      --open             open the HTML report when the run ends
  -o, --out <path>       also write a JSON report
      --har <path>       also write a HAR 1.2 file
  -h, --help             show this
  -v, --version          print the version

Press Ctrl-C to stop and print the summary.
`;

const OPTIONS = {
  config: { type: 'string', short: 'c' },
  threshold: { type: 'string', short: 't' },
  include: { type: 'string', short: 'i', multiple: true },
  ignore: { type: 'string', multiple: true },
  types: { type: 'string' },
  port: { type: 'string', short: 'p' },
  headless: { type: 'boolean' },
  duration: { type: 'string', short: 'd' },
  all: { type: 'boolean', short: 'a' },
  initiator: { type: 'boolean' },
  out: { type: 'string', short: 'o' },
  har: { type: 'string' },
  html: { type: 'string' },
  'no-html': { type: 'boolean' },
  open: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' }
};

/** @param {string[]} argv */
export async function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.version) {
    console.log(version);
    return;
  }

  const overrides = {};
  if (positionals[0]) overrides.target = positionals[0];
  if (values.include) overrides.include = values.include;
  if (values.ignore) overrides.ignore = values.ignore;
  if (values.out) overrides.out = values.out;
  if (values.har) overrides.har = values.har;
  if (values.html) overrides.html = values.html;
  if (values['no-html']) overrides.html = null;
  if (values.open) overrides.open = true;
  if (values.all) overrides.all = true;
  if (values.initiator) overrides.initiator = true;
  if (values.headless) overrides.headless = true;
  if (values.port) overrides.port = Number(values.port);
  if (values.duration) overrides.duration = Number(values.duration);
  if (values.threshold) overrides.thresholds = { default: Number(values.threshold) };
  if (values.types) {
    overrides.resourceTypes = values.types === 'all' ? [] : values.types.split(',').map(type => type.trim());
  }

  // In attach mode there is already a page open, so a target is optional.
  const config = await loadConfig({
    configPath: values.config,
    overrides: overrides.port && !overrides.target ? { ...overrides, target: 'attach' } : overrides
  });

  const attaching = Boolean(config.port);
  const target = config.target === 'attach' ? null : config.target;

  const collector = new Collector(config, record => {
    if (config.all || record.slow) printRecord(record, { initiator: config.initiator });
  });

  const { port, close } = await openChrome(config);
  const { client, navigate } = await attachCollector(port, collector);

  printHeader(config, target, port, attaching);

  if (target) await navigate(target);

  try {
    await waitForExit(config.duration);

    const rows = summarise(collector.records);
    printSummary(rows);

    await writeReports(config, collector.records, rows);
  } finally {
    // Always let Chrome go, even if reporting threw — otherwise we leave an
    // orphaned browser behind.
    await client.close().catch(() => {});
    if (!attaching) await close();
  }
}

/** @param {object} config */
function printHeader(config, target, port, attaching) {
  const lines = [
    `${pc.bold('beagle')} ${pc.dim(`v${version}`)}`,
    `  ${pc.dim('chrome  ')} ${attaching ? `attached on port ${port}` : `launched on port ${port}`}`,
    `  ${pc.dim('target  ')} ${target ?? '(current tab)'}`,
    `  ${pc.dim('include ')} ${config.include.length ? config.include.join(', ') : '(everything)'}`,
    `  ${pc.dim('types   ')} ${config.resourceTypes.length ? config.resourceTypes.join(', ') : '(all)'}`,
    `  ${pc.dim('slow at ')} ${config.thresholds.default}ms default${describeOverrides(config.thresholds)}`
  ];

  if (config.configPath) {
    lines.push(`  ${pc.dim('config  ')} ${path.relative(process.cwd(), config.configPath)}`);
  }

  console.log(`\n${lines.join('\n')}\n`);
  console.log(pc.dim('Watching. Ctrl-C to stop and print the summary.\n'));
}

/** @param {Record<string, number>} thresholds */
function describeOverrides(thresholds) {
  const extra = Object.keys(thresholds).filter(key => key !== 'default');
  return extra.length ? pc.dim(` (+${extra.length} override${extra.length > 1 ? 's' : ''})`) : '';
}

/**
 * Resolve on the first Ctrl-C, or after `duration` seconds if one was given.
 *
 * @param {number|null} duration
 * @returns {Promise<void>}
 */
function waitForExit(duration) {
  return new Promise(resolve => {
    const timer = duration ? setTimeout(stop, duration * 1000) : null;

    function stop() {
      if (timer) clearTimeout(timer);
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      resolve();
    }

    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
}

/**
 * @param {object} config
 * @param {object[]} records
 * @param {object[]} rows
 */
async function writeReports(config, records, rows) {
  const capturedAt = new Date().toISOString();

  if (config.html) {
    const page = toHtml({ records, rows, config, version, capturedAt });
    await writeFile(config.html, page);
    console.log(pc.dim(`HTML report → ${config.html}`));

    if (config.open) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      spawn(opener, [path.resolve(config.html)], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' })
        .on('error', () => {})
        .unref();
    }
  }

  if (config.out) {
    const report = {
      version,
      capturedAt,
      target: config.target,
      thresholds: config.thresholds,
      summary: rows,
      requests: records
    };
    await writeFile(config.out, JSON.stringify(report, null, 2));
    console.log(pc.dim(`JSON report → ${config.out}`));
  }

  if (config.har) {
    await writeFile(config.har, JSON.stringify(toHar(records), null, 2));
    console.log(pc.dim(`HAR → ${config.har}`));
  }
}
