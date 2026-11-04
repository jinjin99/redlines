# Changelog

## Unreleased

- **Data or code**: `capture_states` notes which of a page's text came from its API answers (`<state>.data.json`), and `find_design_edits` marks a designer's edit to such text `! not code`, with the request and key it came from.

## 0.2.0

Designing with it: a requirement drafted in code, a canvas a designer edits and plays through, their edits back in the code.

- **Flows**: exports link the states where a click leads, so the HTML pages click through and Play on a Claude Design canvas walks the flow. A state continuing another's steps is linked from it by itself; other ways go in a state's `links`.
- **Designers' edits** (`find_design_edits`): the edited artboards against the export, as a list of changes like `find_changes`; added artboards come with an outline.
- **`draft_design` prompt** (MCP, and `redlines prompt draft_design`): the whole round trip, step by step, for an agent.
- Installing `#v0.1.0` from GitHub did not build (that tag predates building on install); install `#v0.2.0`.

## 0.1.0

First release.

- **Capture** (`capture_states`): open each state a config lists in a running app (steps, mocked data), record its page tree (elements, text, own styles, React components and props, boxes), a screenshot, and the page frozen as standalone HTML, checked against the page pixel by pixel.
- **Find changes** (`find_changes`): compare two captures and list what was added, removed or changed, where, in words; folded the way a person would describe it (a new table column is one change, a wrapped button is one change). Minified component names are ignored.
- **Review page** (`create_review`): before and after side by side, every change boxed and numbered on both.
- **Editable exports** (`export_design`): standalone HTML, or a Claude Design canvas.
- **See a page** (`view_page`): a screenshot and an outline of what is on screen, for an agent checking its own work.
- **Mock data**: inline `mocks`, a project's own MSW handlers (2.4+ and 3), recordings of a real backend (`record_data`), and a data proxy for the requests a server-rendering app makes on the server (`data_proxy`). One recording file serves both sides.
- **Logins** (`log_in`): the person logs in in a browser window; the login is kept per app, out of git. Values from the environment for CI.
- **MCP server** (`redlines mcp`): the same tools, by the same names, with instructions for when to use them.
- Config checked on load; `now` pins the clock pages see.
