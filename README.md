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
  -o, --out <path>       write a JSON report on exit
      --har <path>       write a HAR 1.2 file on exit
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
    '**/care-performance/**': 2500,
    '**/reports/**': 5000
  },
  redact: ['authorization', 'cookie', 'x-api-key'],
  resourceTypes: ['XHR', 'Fetch']
};
```

Globs match against the whole URL. `**` crosses slashes, `*` does not. When a
URL matches more than one threshold pattern, the longest pattern wins.

See `beagle.config.example.js`.

## Reading the output

```
SLOW    2140ms  200  GET    http://localhost:3000/api/v1/care-performance/ytd wait 2098ms
```

`wait` is the number that usually matters: time between the request leaving the
browser and the first response byte arriving. That is the server thinking. If
`wait` is small but the total is large, the payload is too big or the connection
is slow — a different problem with a different fix.

The summary reports per route:

| column | meaning |
| --- | --- |
| `n` | requests seen |
| `p50` / `p95` / `max` | milliseconds, end to end |
| `slow` | how many crossed the threshold |
| `err` | failures and 4xx/5xx |

Routes are grouped by collapsing ids: `/patients/8821` and `/patients/9134`
both become `/patients/:id`.

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
