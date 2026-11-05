# Changelog

## Unreleased

- From a second blind run: a state whose page went to another address (no steps, yet elsewhere) is flagged in the capture and in `capture_change`, which says to capture it again; a state continues another (and is linked from it) only with the same data, so "the empty list, then a click" is no longer linked from the list with data; a link not on the page is a `note`, not an unlabelled line; mocks match method and path, a POST's body only through a function (documented).
- Found by an agent running `capture_change` on a real app with only the docs: the build no longer runs behind the data proxy (a codegen fetching its schema was answered from the recording); a failed build says why (the end of its log) and `capture_change` says it is building first; a port already in use is said as such, before the data proxy starts; the data proxy has 60 s to load a big recording and is stopped if it doesn't start; mockttp is a dependency, so `npx github:jinjin99/redlines` has the data proxy; a state only the changed version can reach is listed as new with the change, not as a failure; differences in a state the code change does not run in are marked as coming from the captures; generated files are not counted as changed files; mock paths are documented as matching whole.
- **A state's data on top of the recording**: a mock function is given `{ recorded, writes }`, what the recording (or MSW) would answer and how many writes the config's mocks answered before, so a state changes one field of real data ("this claim, rejected") without copying it into the config, and answers differently once the page has sent a write ("Reopen" → the reopened claim). Under `capture_change` the data proxy answers the mocks of the state being captured, so they reach a server-rendered page too.
- `affected_states`: in a changed file no state loaded, imports, re-exports, type declarations and comments are not listed as changes no state shows. A list given more than once on the command line (`--states a --states b`) keeps all of them.
- A page that is HTML but sent with another content type (an app bug: a JSON type leaking onto the document) is shown as HTML instead of as text with nothing running, and the page's errors say so. A base checkout of a monorepo runs its own packages, not the working copy's. A dev server's pages are asked for once before capturing, so the first one doesn't time out while it builds. A capture refused with 401 says the login has probably expired.
- **A change, start to end** (`capture_change`): with `app` in the config (how to build and start it), redlines runs both versions itself: the base, checked out beside the project with your dependencies linked in (its capture kept while nothing it depends on changes), and your working copy. Then it lists what changed and which states the change reaches.
- **Which states a change reaches** (`affected_states`): the lines your diff touched against the source lines each state ran (the browser's coverage through the scripts' source maps), and the changed code no state runs yet, to add a state for or ask about.
- **Prototypes** (`build_prototype`, `redlines serve`): the running app, clickable with no server. Each state's walk (its steps and its links) is recorded whole, login secrets blanked, and a service worker plays it back from a folder for any static host; a write (a mocked or recorded POST) moves it on to what was recorded after it. Several prototypes can share a host with other content: the worker answers only pages opened from a prototype's entry. Each walk is played on the folder offline after building.
- **Log in once.** A login is kept per machine and host (`~/.redlines/auth/<host>.json`), shared by every project, worktree and port, and every run writes back what the app refreshed, so it no longer expires with the app's first token. Logins kept in a project by an older redlines move there on first use.
- Component props holding an id made up on each render (React's `useId`, react-aria's ids) are left out of the page tree: they differ on every load and made every captured field look changed.

## 0.3.0

Found running a real server-rendered app (a dev server, then its production build) through the whole design round trip.

- **Data or code**: `capture_states` notes which of a page's text came from its API answers (`<state>.data.json`), and `find_design_edits` marks a designer's edit to such text `! not code`, with the request and key it came from.
- **Canvas images**: inline images become files beside the artboards (`project/assets/`), so a Claude Design canvas takes the export as it is; nothing to upload by hand.
- **Recordings**: a request recorded more than once answers with its successful answer (a 401 recorded just before the app refreshed its token made the app log out on replay).
- **Steps** wait for the network to go quiet first: on a server-rendered page a click before its scripts take over did nothing.
- **Changes nobody can see** (elements of no size and no text, like a portal's mount point) are no longer listed.

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
