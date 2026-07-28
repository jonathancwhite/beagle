import { pathToFileURL } from 'node:url';
import { access } from 'node:fs/promises';
import path from 'node:path';

const CONFIG_NAMES = ['beagle.config.js', 'beagle.config.mjs'];

export const defaults = {
  /** Page to open. Overridden by the CLI's positional argument. */
  target: null,
  /** Only requests matching one of these are tracked. Empty means all. */
  include: [],
  /** Requests matching one of these are dropped, even if included. */
  ignore: [],
  /** Milliseconds. `default` applies unless a longer pattern matches. */
  thresholds: { default: 800 },
  /** Header names blanked out before anything is stored or printed. */
  redact: ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization'],
  /** Resource types to watch. CDP names: XHR, Fetch, Document, Script, ... */
  resourceTypes: ['XHR', 'Fetch'],
  /** Write a JSON report here on exit. */
  out: null,
  /** Write a HAR 1.2 file here on exit. */
  har: null,
  /** Where the HTML report goes. Set to null to skip it. */
  html: 'beagle-report.html',
  /** Open the HTML report in the default browser when the run ends. */
  open: false,
  /** Print every tracked request, not just the slow ones. */
  all: false,
  /** Print the script frame that fired each request, under its line. */
  initiator: false,
  /** Attach to an already-running Chrome on this debugging port. */
  port: null,
  /** Stop after this many seconds. Null means run until Ctrl-C. */
  duration: null,
  headless: false
};

/**
 * Walk up from `cwd` looking for a config file.
 *
 * @param {string} cwd
 * @returns {Promise<string|null>}
 */
async function findConfig(cwd) {
  let dir = path.resolve(cwd);

  for (;;) {
    for (const name of CONFIG_NAMES) {
      const candidate = path.join(dir, name);
      try {
        await access(candidate);
        return candidate;
      } catch {
        // keep looking
      }
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Merge defaults, an optional config file, and CLI overrides. CLI wins.
 *
 * @param {{configPath?: string|null, cwd?: string, overrides?: object}} opts
 * @returns {Promise<object & {configPath: string|null}>}
 */
export async function loadConfig({ configPath = null, cwd = process.cwd(), overrides = {} } = {}) {
  const resolved = configPath ? path.resolve(cwd, configPath) : await findConfig(cwd);
  let fileConfig = {};

  if (resolved) {
    const mod = await import(pathToFileURL(resolved).href);
    fileConfig = mod.default ?? mod.config ?? {};
  }

  const thresholds = {
    ...defaults.thresholds,
    ...(fileConfig.thresholds ?? {}),
    ...(overrides.thresholds ?? {})
  };

  const merged = { ...defaults, ...fileConfig, ...overrides, thresholds };

  if (!merged.target) {
    throw new Error('no target URL. Pass one as an argument, or set `target` in beagle.config.js');
  }

  merged.redact = merged.redact.map(name => name.toLowerCase());
  merged.configPath = resolved;

  return merged;
}
