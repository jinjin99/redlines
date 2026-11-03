# Changelog

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
