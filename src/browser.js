import CDP from 'chrome-remote-interface';
import * as chromeLauncher from 'chrome-launcher';

/**
 * Either launch a fresh Chrome or attach to one already running with
 * `--remote-debugging-port`. Attaching is the useful mode when you want to
 * keep a logged-in session.
 *
 * @param {object} config
 * @returns {Promise<{port: number, close: () => Promise<void>}>}
 */
export async function openChrome(config) {
  if (config.port) {
    return { port: config.port, close: async () => {} };
  }

  // Start blank on purpose: we navigate only once the collector is attached,
  // otherwise the page load itself is already over by the time we listen.
  const chrome = await chromeLauncher.launch({
    startingUrl: 'about:blank',
    chromeFlags: [
      ...(config.headless ? ['--headless=new'] : []),
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  return { port: chrome.port, close: () => chrome.kill() };
}

/**
 * Attach the collector to a page target and start streaming Network events.
 *
 * @param {number} port
 * @param {import('./collector.js').Collector} collector
 * @returns {Promise<{client: object, navigate: (url: string) => Promise<void>}>}
 */
export async function attachCollector(port, collector) {
  const client = await CDP({
    port,
    target: targets => {
      const page = targets.find(target => target.type === 'page');
      if (!page) throw new Error('no page target found in Chrome');
      return page;
    }
  });

  const { Network, Page } = client;

  await Promise.all([Network.enable(), Page.enable()]);

  Network.requestWillBeSent(params => collector.requestWillBeSent(params));
  Network.responseReceived(params => collector.responseReceived(params));
  Network.loadingFinished(params => collector.loadingFinished(params));
  Network.loadingFailed(params => collector.loadingFailed(params));

  return {
    client,
    navigate: url => Page.navigate({ url })
  };
}
