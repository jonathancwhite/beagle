/**
 * Tiny glob matcher, so we don't pull in micromatch for four wildcards.
 *
 *   **  matches anything, including slashes
 *   *   matches anything except a slash
 *   ?   matches a single non-slash character
 *
 * Patterns are matched against the full URL, so `**\/api/v1/**` and
 * `*://localhost:3000/**` both work.
 */

const SPECIAL = /[.+^${}()|[\]\\]/g;

/** @param {string} pattern @returns {RegExp} */
export function globToRegExp(pattern) {
  let out = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i += 1;
      } else {
        out += '[^/]*';
      }
    } else if (char === '?') {
      out += '[^/]';
    } else {
      out += char.replace(SPECIAL, '\\$&');
    }
  }

  return new RegExp(`^${out}$`);
}

const cache = new Map();

/** @param {string} value @param {string} pattern @returns {boolean} */
export function matches(value, pattern) {
  let re = cache.get(pattern);
  if (!re) {
    re = globToRegExp(pattern);
    cache.set(pattern, re);
  }
  return re.test(value);
}

/** @param {string} value @param {string[]} patterns @returns {boolean} */
export function matchesAny(value, patterns) {
  return patterns.some(pattern => matches(value, pattern));
}

/**
 * Find the most specific threshold pattern a URL matches. "Most specific"
 * means the longest pattern, which is a crude but reliable proxy — a caller
 * writing `**\/reports/**` over a `default` clearly means the narrower one
 * to win.
 *
 * @param {string} url
 * @param {Record<string, number>} thresholds
 * @returns {number}
 */
export function thresholdFor(url, thresholds) {
  let best = thresholds.default ?? 800;
  let bestLength = -1;

  for (const [pattern, ms] of Object.entries(thresholds)) {
    if (pattern === 'default') continue;
    if (matches(url, pattern) && pattern.length > bestLength) {
      best = ms;
      bestLength = pattern.length;
    }
  }

  return best;
}
