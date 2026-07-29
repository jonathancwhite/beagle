# Running beagle from an agent

Beagle is a long-running watcher. It prints nothing useful until it stops, and
it only writes its reports on a clean stop. Everything below exists to make sure
you stop it cleanly.

**The one rule: stop beagle with SIGINT (`kill -INT`), never with SIGKILL.**

A hard kill throws away the whole session — no summary, no HTML, no JSON. This
is the mistake agents make: they start beagle as a background job, the human
says "I'm done clicking", and the agent kills the shell instead of interrupting
the process. The session is gone and cannot be recovered.

## The pattern

Start it in the background and keep the process id in a file:

```bash
(npx @jonathancwhite/beagle http://localhost:3000 \
   -o beagle-run.json --html beagle-run.html \
   > beagle-run.log 2>&1 & echo $! > beagle-run.pid)
```

Tell the human to click through the app, and to say when they are done.

When they say so, interrupt it and wait for it to finish writing:

```bash
kill -INT $(cat beagle-run.pid)
sleep 3
```

Then read the results:

```bash
cat beagle-run.log      # the summary table, as a human would see it
cat beagle-run.json     # every request, for you to work with
```

Always pass `-o <path>`. The JSON is what you should reason from — parse that
rather than scraping the terminal table.

Signals reach beagle through `npx`, so the pid from `$!` is the right one to
interrupt. If you lose the pid file, `pkill -INT -f 'beagle'` will do, though it
hits every beagle on the machine.

## What a clean stop tidies up

On SIGINT beagle writes the reports first, then closes Chrome. If it launched
Chrome, it kills it and deletes the temporary profile directory. If you attached
with `--port`, your Chrome is left alone — that is the point of attaching.

A hard kill skips all of it. Chrome stays running with a profile directory of
tens of megabytes under the system temp folder, and nothing tells you it is
there. If you or someone else killed a beagle the wrong way, clean up after it:

```bash
pgrep -f 'remote-debugging-port.*lighthouse' # orphaned Chromes, if any
kill <pid>
rm -rf /var/folders/*/*/T/lighthouse.*       # macOS; only ones no process holds
```

Check nothing is using a directory before removing it — a beagle run in another
terminal will be holding one.

## If you cannot manage a background process

Give it a deadline and let it stop itself:

```bash
npx @jonathancwhite/beagle http://localhost:3000 -d 300 -o beagle-run.json
```

It runs for 300 seconds, stops on its own, writes the reports, and exits. Agree
the number with the human first — when the clock runs out the session ends,
whether or not they have finished clicking.

## Choosing how Chrome starts

Beagle launches its own Chrome by default, with a clean profile. That means the
human has to log in again. If the app needs a login, attach to the Chrome they
are already using instead:

```bash
# the human runs this once, in their own terminal
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 --user-data-dir=/tmp/beagle-profile

# then you run
npx @jonathancwhite/beagle --port 9222 -o beagle-run.json
```

With `--port` and no URL, beagle watches whatever tab is open.

Do not pass `--headless` for a session a human is meant to click through —
there is no window for them to click. Headless is for `-d` runs you drive
yourself.

## Common flags

| flag | when to use it |
| --- | --- |
| `-o <path>` | always — the JSON you will read |
| `--html <path>` | when a human wants to look at the run afterwards |
| `-t <ms>` | change what counts as slow (default 800) |
| `-i <glob>` | narrow to one API, e.g. `-i '**/api/**'` |
| `--types all` | include documents, scripts and images, not just XHR/Fetch |
| `-a` | print every request, not only the slow ones |
| `-d <s>` | stop after this many seconds |
| `--no-html` | skip the HTML report |

## What the JSON holds

```json
{
  "version": "0.1.0",
  "capturedAt": "2026-07-29T10:27:00.000Z",
  "target": "http://localhost:3000",
  "thresholds": { "default": 800 },
  "summary": [ { "page": "/reports", "route": "GET /api/v1/reports/:id",
                 "n": 4, "p50": 210, "p95": 2140, "max": 2140,
                 "slow": 1, "err": 0 } ],
  "requests": [ /* one entry per request, with the full timing breakdown */ ]
}
```

`wait` on a request is the time between the request leaving the browser and the
first response byte — the server thinking. That is usually the number that
matters. A large total with a small `wait` means a fat payload or a slow
connection, which is a different problem.

Routes are grouped with ids collapsed (`/orders/8821` becomes `/orders/:id`),
and the same route called from two different pages gets two rows.

## Checklist

1. Check the app is running at the URL before you start beagle.
2. Start beagle in the background, save the pid, pass `-o`.
3. Say plainly that you are watching, and ask the human to tell you when done.
4. On their word: `kill -INT $(cat …pid)`, wait a few seconds.
5. Confirm the JSON file exists before you report anything.
6. Read the JSON and report the slow routes, with the page each came from.

## Notes

- Beagle changes nothing in the app. No SDK, no proxy.
- Request and response bodies are never read. Only timing and metadata.
- Header names in the config's `redact` list are blanked out. Check that list
  before pointing beagle at anything sensitive.
- A run with no clicks records nothing. If the summary is empty, the human
  probably never got to the app, or `--include` was too narrow.
