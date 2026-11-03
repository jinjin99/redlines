# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setting up

```bash
git clone https://github.com/jinjin99/redlines.git
cd redlines
npm install
npx playwright-core install chromium   # if you have no Chromium from Playwright yet
npm test
```

`npm test` builds with `tsc` and runs the tests, which drive a real Chromium. `npm run lint` runs ESLint, and `npm run demo` captures the example app before and after a change into `.redlines/demo/`.

## Making a change

- Keep a change to one thing, with a test that fails without it. Behaviour found on a real app deserves a test that reproduces it on a small fixture (see `test/fixtures/`).
- `src/page/` runs inside the page: those functions are sent there as source, so they import nothing at run time and must stay self-contained.
- A tool is defined once, in `src/tools.ts`; the command line and the MCP server are both made from that list, so they always agree.
- Error messages say what is wrong and what to do about it. They never print secrets: not passwords, tokens or cookies, and not a variable's value.
- CI lints, builds and tests on Node 20, 22 and 24 on Linux, and on macOS and Windows. Paths go through `path`, never a literal `/`.

## Releasing

Update `CHANGELOG.md` and the version in `package.json`, tag `vX.Y.Z`, and publish with `npm publish` (it lints and tests first).
