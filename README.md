# beagle

Sniff out slow HTTP requests in a running web app. Beagle drives Chrome over the
DevTools Protocol, watches every request the page makes, and flags the ones that
take longer than you told it to expect.

It changes nothing in the app under test. No SDK, no interceptor, no proxy.

```bash
npx beagle http://localhost:3000
```

Click around. Press Ctrl-C. You get a table of the slowest routes.

## Why not just use DevTools

DevTools shows you one page load at a time and forgets everything on refresh.
Beagle watches a whole session, groups requests by route, and gives you p50 /
p95 / max per route with a pass-fail threshold you set per pattern. It also
writes the session to JSON or HAR so you can diff two runs.

## Usage

```
beagle [url] [options]

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
```

By default beagle tracks only `XHR` and `Fetch` — your API calls. Pass
`--types all` to include documents, scripts, images, and the rest.

### Attaching to a browser you are already logged into

Launching a fresh Chrome gives you a clean profile, which means logging in
again. To watch your existing session instead, start Chrome with a debugging
port and attach:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/beagle-profile

npx beagle --port 9222
```

With `--port` and no URL, beagle watches whatever tab is already open.

## Config

Drop a `beagle.config.js` in the root of the app you are testing. Beagle walks
up from the working directory to find it. Anything on the command line wins.

```js
export default {
  target: 'http://localhost:3000',
  include: ['**/api/v1/**'],
  ignore: ['**/auth/refresh'],
  thresholds: {
    default: 800,
    '**/search/**': 2000,
    '**/reports/**': 5000
  },
  redact: ['authorization', 'cookie', 'x-api-key'],
  resourceTypes: ['XHR', 'Fetch']
};
```

Globs match against the whole URL. `**` crosses slashes, `*` does not. When a
URL matches more than one threshold pattern, the longest pattern wins.

See `beagle.config.example.js`.

## The HTML report

Every run writes `beagle-report.html` — one self-contained page, no external fonts,
scripts or images, so you can mail it around or open it offline. It holds:

- headline counts: requests tracked, how many were slow, the worst one, failures
- a bar chart of every request over threshold, hover for method, server wait and page
- the full table, and a rollup of every route by page with p50 / p95 / max
- **Signals** — counted patterns worth a look, each one saying how it was arrived at:
  endpoints whose timing swings widely, calls repeated on a single page, and how much
  of the slow time was server wait

Signals are counts, not conclusions. They point; you decide.

```bash
npx beagle http://localhost:3000 --open          # write it and open it
npx beagle http://localhost:3000 --html perf.html
npx beagle http://localhost:3000 --no-html       # terminal only
```

## Reading the output

```
SLOW    2140ms  200  GET    /api/v1/reports/summary wait 2098ms ← /reports/summary
```

`wait` is the number that usually matters: time between the request leaving the
browser and the first response byte arriving. That is the server thinking. If
`wait` is small but the total is large, the payload is too big or the connection
is slow — a different problem with a different fix.

The arrow shows the page that was on screen when the request went out, so you
can find your way back to the screen that triggered it. Single-page apps are
handled: beagle follows `history.pushState` route changes, not just full
navigations. Requests from an embedded iframe — a third-party widget, say —
are attributed to the iframe rather than the host page.

For the calling code as well as the calling page, add `--initiator`:

```
SLOW    2140ms  200  GET    /api/v1/reports/summary wait 2098ms ← /reports/summary
        fetchSummary @ http://localhost:3000/src/api/reports.js:88
```

The summary reports per page and route:

| column | meaning |
| --- | --- |
| `page` | where the request was fired from |
| `n` | requests seen |
| `p50` / `p95` / `max` | milliseconds, end to end |
| `slow` | how many crossed the threshold |
| `err` | failures and 4xx/5xx |

Routes are grouped by collapsing ids: `/orders/8821` and `/orders/9134`
both become `/orders/:id`. The same endpoint called from two different
screens gets two rows — lumping them together hides the slow one.

## What it records

Method, URL, status, byte count, and the CDP timing breakdown — DNS, connect,
TLS, send, wait, download. Headers are recorded with the names in `redact`
blanked out.

**Request and response bodies are never read.** This is deliberate. Beagle is
built to be safe to point at applications handling regulated data, so it
collects timing and metadata only. Check the `redact` list before running
against anything sensitive.

## Requirements

Node 20 or newer, and Chrome installed.

## License

MIT
