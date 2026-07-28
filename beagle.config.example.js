/**
 * Copy to `beagle.config.js` in the root of the app you want to sniff.
 * Every field is optional; the CLI overrides whatever it sets.
 */
export default {
  target: 'http://localhost:3000',

  // Only track these. Leave empty to track everything.
  include: ['**/api/v1/**'],

  // Noise you never want to see.
  ignore: ['**/auth/refresh', '**/healthz'],

  // Milliseconds. The longest matching pattern wins; `default` is the fallback.
  thresholds: {
    default: 800,
    '**/care-performance/**': 2500,
    '**/reports/**': 5000
  },

  // Header names blanked before anything is printed or written to disk.
  // Never remove `authorization` when working against regulated data.
  redact: ['authorization', 'cookie', 'set-cookie', 'x-api-key'],

  // CDP resource types. Empty array means all of them.
  resourceTypes: ['XHR', 'Fetch'],

  // Print every request, not just the slow ones.
  all: false
};
