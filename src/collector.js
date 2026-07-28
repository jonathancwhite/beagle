import { matchesAny, thresholdFor } from './match.js';

/**
 * Turns raw CDP Network events into finished request records.
 *
 * CDP reports timings in two different units, which is the only genuinely
 * fiddly part here: `timing.requestTime` is a monotonic clock in *seconds*,
 * while every field beside it is an offset in *milliseconds* from that
 * moment. `loadingFinished.timestamp` is back in seconds again.
 */
export class Collector {
  /**
   * @param {object} config
   * @param {(record: object) => void} onFinish
   */
  constructor(config, onFinish) {
    this.config = config;
    this.onFinish = onFinish;
    this.pending = new Map();
    this.records = [];
    this.mainFrameId = null;
    this.currentPage = null;
  }

  /** @param {string} frameId @param {string} url */
  setMainFrame(frameId, url) {
    this.mainFrameId = frameId;
    this.currentPage = url;
  }

  /** Ignore sub-frames: an embedded report navigating is not a page change. */
  setPage(frameId, url) {
    if (frameId === this.mainFrameId) this.currentPage = url;
  }

  /**
   * Where a request was fired from. Prefer the URL of the document that
   * actually made the call — that keeps iframe traffic (an embedded Power BI
   * report, say) labelled as its own page rather than the host page. Fall
   * back to the tracked main-frame URL.
   *
   * @param {string|undefined} documentURL
   * @param {string|undefined} frameId
   * @returns {string|null}
   */
  pageFor(documentURL, frameId, type, url) {
    // A top-level document request IS the navigation, and it goes out before
    // the frame reports its new URL. Attribute it to where it is heading,
    // not to the page being left behind.
    if (type === 'Document') return url;
    if (frameId && frameId !== this.mainFrameId && documentURL) return documentURL;
    return this.currentPage ?? documentURL ?? null;
  }

  /** @param {Record<string,string>} headers @returns {Record<string,string>} */
  redactHeaders(headers = {}) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
      out[name] = this.config.redact.includes(name.toLowerCase()) ? '[redacted]' : value;
    }
    return out;
  }

  /** @param {string} url @param {string} type @returns {boolean} */
  tracks(url, type) {
    if (!url.startsWith('http')) return false;
    if (this.config.resourceTypes.length && !this.config.resourceTypes.includes(type)) return false;
    if (this.config.include.length && !matchesAny(url, this.config.include)) return false;
    if (this.config.ignore.length && matchesAny(url, this.config.ignore)) return false;
    return true;
  }

  /** CDP `Network.requestWillBeSent` */
  requestWillBeSent({ requestId, request, timestamp, wallTime, type, redirectResponse, documentURL, frameId, initiator }) {
    // A redirect reuses the request id, so close out the previous hop first.
    if (redirectResponse && this.pending.has(requestId)) {
      this.finish(requestId, { timestamp, encodedDataLength: 0 });
    }

    if (!this.tracks(request.url, type ?? 'Other')) return;

    this.pending.set(requestId, {
      requestId,
      url: request.url,
      method: request.method,
      type: type ?? 'Other',
      requestHeaders: this.redactHeaders(request.headers),
      page: this.pageFor(documentURL, frameId, type, request.url),
      initiator: describeInitiator(initiator),
      startedAt: wallTime ? wallTime * 1000 : Date.now(),
      startTimestamp: timestamp
    });
  }

  /** CDP `Network.responseReceived` */
  responseReceived({ requestId, response, type }) {
    const entry = this.pending.get(requestId);
    if (!entry) return;

    entry.status = response.status;
    entry.mimeType = response.mimeType;
    entry.type = type ?? entry.type;
    entry.responseHeaders = this.redactHeaders(response.headers);
    entry.fromCache = Boolean(response.fromDiskCache || response.fromPrefetchCache);
    entry.timing = response.timing ?? null;
    entry.remoteAddress = response.remoteIPAddress ?? null;
  }

  /** CDP `Network.loadingFinished` */
  loadingFinished({ requestId, timestamp, encodedDataLength }) {
    this.finish(requestId, { timestamp, encodedDataLength });
  }

  /** CDP `Network.loadingFailed` */
  loadingFailed({ requestId, timestamp, errorText, canceled }) {
    this.finish(requestId, { timestamp, encodedDataLength: 0, error: canceled ? 'canceled' : errorText });
  }

  /**
   * @param {string} requestId
   * @param {{timestamp: number, encodedDataLength: number, error?: string}} end
   */
  finish(requestId, { timestamp, encodedDataLength, error }) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);

    const timing = entry.timing;
    const base = timing ? timing.requestTime : entry.startTimestamp;
    const total = Math.max(0, (timestamp - base) * 1000);

    // `-1` is CDP's "this phase did not happen" marker (cached, reused socket).
    const span = (start, end) => (timing && start >= 0 && end >= 0 ? Math.max(0, end - start) : null);

    const record = {
      url: entry.url,
      route: routeOf(entry.url),
      page: entry.page ?? null,
      pagePath: pagePathOf(entry.page),
      initiator: entry.initiator ?? null,
      method: entry.method,
      type: entry.type,
      status: entry.status ?? null,
      mimeType: entry.mimeType ?? null,
      error: error ?? null,
      fromCache: entry.fromCache ?? false,
      startedAt: entry.startedAt,
      duration: round(total),
      timings: {
        dns: round(span(timing?.dnsStart, timing?.dnsEnd)),
        connect: round(span(timing?.connectStart, timing?.connectEnd)),
        tls: round(span(timing?.sslStart, timing?.sslEnd)),
        send: round(span(timing?.sendStart, timing?.sendEnd)),
        // Server think time: request fully sent -> first response byte.
        wait: round(span(timing?.sendEnd, timing?.receiveHeadersEnd)),
        download: timing ? round(Math.max(0, total - timing.receiveHeadersEnd)) : null
      },
      bytes: encodedDataLength ?? 0,
      remoteAddress: entry.remoteAddress ?? null,
      requestHeaders: entry.requestHeaders,
      responseHeaders: entry.responseHeaders ?? {},
      threshold: thresholdFor(entry.url, this.config.thresholds)
    };

    record.slow = record.duration > record.threshold;

    this.records.push(record);
    this.onFinish(record);
  }
}

/**
 * The bit of a page URL worth showing in a table — path and query, no host.
 * Hash routes are kept whole, since for some apps that IS the route.
 *
 * @param {string|null|undefined} url
 * @returns {string}
 */
export function pagePathOf(url) {
  if (!url) return '?';
  if (url === 'about:blank') return 'about:blank';

  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}${parsed.hash}` || '/';
  } catch {
    return url;
  }
}

/**
 * Boil a CDP initiator down to one readable line. The script stack is the
 * useful part: it points at the code that fired the request.
 *
 * @param {object|undefined} initiator
 * @returns {string|null}
 */
function describeInitiator(initiator) {
  if (!initiator) return null;

  const frame = initiator.stack?.callFrames?.find(candidate => candidate.url);
  if (frame) {
    const name = frame.functionName || '(anonymous)';
    return `${name} @ ${frame.url}:${frame.lineNumber + 1}`;
  }

  if (initiator.url) return `${initiator.type} @ ${initiator.url}`;
  return initiator.type ?? null;
}

/** @param {number|null} value @returns {number|null} */
function round(value) {
  return value === null || value === undefined ? null : Math.round(value);
}

/**
 * Collapse a URL into a groupable route: drop the query string and swap
 * id-looking path segments for `:id`, so `/patients/8821` and
 * `/patients/9134` land in the same bucket.
 *
 * @param {string} url
 * @returns {string}
 */
export function routeOf(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const segments = parsed.pathname.split('/').map(segment => {
    if (/^\d+$/.test(segment)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ':uuid';
    if (segment.length > 24 && /\d/.test(segment)) return ':id';
    return segment;
  });

  return `${parsed.host}${segments.join('/')}`;
}
