# Contributing to Bercy

Thanks for helping. Bug reports, runtime adapters, workflow files and fixes are all welcome. Issues and pull requests can be written in English or Chinese.

## Set up

You need an Apple Silicon Mac, Node.js 26 and npm.

```sh
npm ci
npm start      # run the desktop app from source
npm test       # run the unit tests (no runtime or sign-in needed)
```

To try real workflows, install and sign in to at least one runtime (Codex, Claude Code, OpenClaw, DeepSeek Harness or Pi), then connect it in **Settings → Runtimes**. Two runtimes let review nodes run on a different model.

`npm run test:regression` runs real scenarios against your signed-in Codex and uses model quota. See the [regression guide](regression/README.md) (Chinese).

## Where things live

| Area | Files |
| --- | --- |
| Electron main process, runtime processes, storage | `desktop/*.cjs` |
| Prompts sent to runtimes | `desktop/prompts.cjs`, `desktop/planning-guide.md` |
| Runtime adapters | `desktop/runtimes.cjs`, `desktop/codex-app.cjs` |
| Canvas, scheduling and the rest of the window | `dist/*.js`, plain scripts loaded by `dist/index.html` |
| DAG rules: validation, live changes, workflow files | `dist/dag.js` |
| Routing nodes to runtimes | `dist/connections.js` |
| Interface text in English | `dist/i18n.js` |
| Tests | `desktop/test/*.test.cjs` |

The window talks to the main process only through `window.relayHost`, defined in `desktop/preload.cjs`. Without it, the window runs as a browser demo with simulated runtimes, which is handy for UI work.

## Making a change

- Keep pull requests focused on one change and explain what a user will notice.
- Add or update a test in `desktop/test/` for behaviour changes, and run `npm test` before you push.
- Interface text is written in Chinese and wrapped in `uiText(...)`. Add the English version to `dist/i18n.js` in the same pull request.
- Bercy itself must not make network requests. Prompts go only to the runtimes the user connects.
- Treat anything read from a runtime, an imported workflow file or a project folder as untrusted input.

## Adding a runtime

Any CLI that speaks the [Agent Client Protocol](https://agentclientprotocol.com) can already be added in **Settings** without code. For a built-in adapter, add an entry to the runtime list in `desktop/runtimes.cjs` with its command, protocol, capabilities and login hint, add the matching entry in `dist/connections.js`, and add tests like those in `desktop/test/runtimes.test.cjs` and `desktop/test/phase3.test.cjs`, which drive the adapter against a small fake CLI.

## Sharing workflows

Workflows exported from **Saved workflows → Export** are `.bercy.json` files. If you've built one that works well, open an issue with the file attached and a sentence on what it's for. Export it with *Structure only* unless the node briefs are meant to be shared.

## Reporting security issues

Please don't open a public issue for a security problem. Use [GitHub's private vulnerability reporting](https://github.com/beProactive01/Bercy/security/advisories/new) instead.
