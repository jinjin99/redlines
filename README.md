# redlines

**See what a UI change does, state by state.**

Code has diffs, APIs have contracts, data has schemas. A change to how a page *looks and behaves* has nothing you can review: a JSX diff doesn't show the page, and a screenshot pasted in a PR shows one state of it. Now that designers, PMs and AI agents change UIs straight in code, often nobody looks at the page at all before it ships.

redlines opens your running app in each state you care about (a page, a dialog opened, a form filled in, an empty list), records what is on screen, and compares it with the same states before the change. You get a list of what changed, element by element, and a review page with before and after side by side and every change boxed and numbered on both.

```
1. changed in page › page-header, after "Orders": <button> "Export" <button> "New order"  (was: <button> "Export")
2. added ×4 in page › card › table, heading of column "Refund" (after "Total"): "Refund" | <button> "Refund"
3. changed ×2 in page › card › table, in column "Status" (after "Customer"): "Paid": background-color rgb(205, 236, 205) → rgb(183, 228, 183), font-weight (none) → 600
```

![The review page: the order list before and after, each change boxed and numbered, and the list of changes](docs/report.png)

Try it on the example app in this repo: `npm install && npm run demo` (it writes `.redlines/demo/`).

It is not pixel diffing. redlines reads the rendered page: elements, text, the styles that make them look the way they do, and in React apps the component each element comes from and its props (`<Badge tone="success">`). So it can tell you *what* changed and *where*, in words, and ignore what moved only because something above it grew.

## Quick start

```bash
npm install --save-dev redlines
npx playwright-core install chromium   # if you don't have a Chromium from Playwright already
```

Describe the states to look at in `redlines.config.mjs`:

```js
export default {
    viewport: { width: 1280, height: 800 },
    // Answer API requests with fixed data, so both versions show the same thing.
    mocks: {
        'GET /api/orders': [{ id: '#1001', customer: 'Ada Lovelace', status: 'Paid', total: '$120.00' }],
    },
    states: {
        list: { path: '/orders', title: 'Order list' },
        details: { path: '/orders', title: 'Order details', steps: [{ click: 'text=#1001' }] },
        empty: { path: '/orders', title: 'No orders yet', mocks: { 'GET /api/orders': [] } },
    },
};
```

Shoot the app before and after the change, then compare:

```bash
npx redlines shoot --base http://localhost:3000 --out .redlines/before   # on main
npx redlines shoot --base http://localhost:3001 --out .redlines/after    # on your branch
npx redlines diff .redlines/before .redlines/after
npx redlines report .redlines/before .redlines/after --out .redlines/report
open .redlines/report/index.html
```

The report is a folder of static files: open it locally, or put it on any static host and link it from the PR.

## Commands

| Command | What it does |
| --- | --- |
| `redlines shoot --out <dir> [--base <url>] [--config <file>] [state…]` | Opens each state, does its steps, waits for the page to settle, and writes `<state>.json` (the page tree) and `<state>.png` (a full-page screenshot) into `<dir>`, with a `manifest.json`. Name states to shoot only those. |
| `redlines diff <before> <after> [--json]` | The changes between two shot folders, state by state (or between two `.json` page trees). `--json` for tools and AI agents. |
| `redlines report <before> <after> --out <dir> [--title <text>]` | The review page: `index.html`, the screenshots, and `changes.json`. |
| `redlines export <shots> --out <dir> [--format html\|dc] [--title <text>]` | The states as editable design files. `html`: each state as one standalone HTML file (styles inlined, scripts out), to open and edit anywhere. `dc`: a [Claude Design](https://claude.ai) canvas, one artboard per state. |

## For coding agents (MCP)

redlines is also an MCP server, so an agent that changes UI code can look at what it did and show people the change:

```bash
claude mcp add redlines -- npx redlines mcp     # Claude Code; other MCP clients: command "npx", args ["redlines", "mcp"]
```

Run it from the project folder: every path the tools read or write stays inside it (`REDLINES_ROOT` sets another).

| Tool | What it does |
| --- | --- |
| `view_page` | Opens a page of the running app (steps and mocks optional) and returns a screenshot, an outline of what is on screen and any page errors. Writes nothing. |
| `list_states` | The project's states (`redlines.config.*`), or how to write the config. |
| `capture_states` | One version of the app, every state, into a folder. |
| `find_changes` | The changes between two captured folders. |
| `create_review` | The review page for two captured folders. |
| `export_design` | Editable design files of a captured folder (Claude Design canvas or HTML). |

The server tells the agent when to use them: `view_page` on every page it changed before saying it is done; to show a change, shoot the app before (main branch) and after (its working copy), compare, and hand over the report.

## Config

| Key | |
| --- | --- |
| `baseURL` | Where the app runs. `--base` overrides it, so one config shoots both versions. |
| `viewport` | `{ width, height }`, default 1280 × 800. A state can set its own. |
| `states` | `{ <name>: { path, title, steps, mocks, viewport, settle, ignore } }`. Names are letters, digits, `-` and `_`. |
| `steps` | Done in order after the page loads: `{ click: <selector> }`, `{ fill: [<selector>, <text>] }`, `{ press: <key> }`, `{ hover: <selector> }`, `{ select: [<selector>, <value>] }`, `{ waitFor: <selector> }`, `{ wait: <ms> }`, or a function `async page => …` (Playwright's page). Selectors are [Playwright selectors](https://playwright.dev/docs/locators): `text=Save`, `role=button[name="Save"]`, CSS. |
| `mocks` | `{ "<METHOD> <path>": <answer> }`, for every state, and per state on top. The path is matched from the start, `*` matches anything. An answer is JSON data, `{ status, json \| body, headers }`, or a function of the request. Requests not listed go to the network. |
| `ignore` | A CSS selector for parts of the page to leave out (a clock, an ad slot). |
| `settle` | Milliseconds to wait after the page is idle, default 300. |
| `locale`, `timezone` | Default `en-US` and `UTC`, so dates read the same on every machine. |

Animations and transitions are turned off and the caret hidden while shooting, so two shots of the same page are the same.

## What it records

`<state>.json` is the page tree:

```js
{
  version: 1, url, title,
  viewport: { width, height }, size: { width, height },   // size: the whole page
  state: { name, title, path },
  root: {
    tag: 'body',
    name: 'page',                                          // what a person calls it: aria-label, component, readable class, landmark
    component: { name: 'Badge', props: { tone: 'info' } }, // React only: the component whose whole output this element is
    classes: ['badge'],                                    // readable ones only, not build hashes
    attrs: { href, src, alt, role, 'aria-label', value, … },
    style: { color, 'background-color', 'font-size', padding-*, gap, … },
    box: [x, y, width, height],                            // page pixels
    children: [ …elements, { text: 'Paid', box: [x, y, w, h] } ]
  }
}
```

`shoot` also freezes each state as `<state>.html`: the page as rendered, with every stylesheet it could read inlined, same-origin images as data URLs, and no scripts. It is opened again and compared with the screenshot pixel by pixel; the share that matches is `fidelity` in `manifest.json`. That file is what `export` builds on.

Only what is on screen is in the page tree: hidden elements, screen-reader-only text and invisible measuring copies are left out, since changing them changes nothing anyone sees.

`changes.json` (from `report`, or `diff --json`) lists, per state, each change: `kind` (`added`, `removed`, `changed`), `where` (the named elements it is in and the text just before it), `now` and `was` (what it holds: components, interactive elements and text), `styles` (for a restyle: each property, before and after), `count` (one change repeated, like a cell in every row) and `boxes.before` / `boxes.after` (where it is on each page).

## How changes are found

Each tree is read into a sequence (an element opening, its text, its closing), the two sequences are aligned (longest common subsequence), and each run that differs becomes a change. A few rules make the list read like a person would describe it:

- A run is moved to where it is whole elements, so an added button isn't reported as half of one button and half of the next.
- Content wrapped in a new element, and edits a few tokens apart in one place, are one change.
- In a table, changes are grouped by column: a new column is one change, not one per row.
- Inherited styles (color, font) count where they are set, not again on every child.
- Boxes are not compared: a page that only moved down is not a change.

## Status

Early. What works today: shooting states of any web app with Playwright, mocked APIs, React component names and props, the change list, the review page, editable exports (HTML, Claude Design), and an MCP server for coding agents. Planned:

- More export targets for the editable states (Figma).
- A GitHub Action that shoots both sides of a PR and comments with the review page.
- Reusing the mocks an app already has (MSW handlers).
- Presets for component libraries, to name changes in their terms.

## License

MIT
