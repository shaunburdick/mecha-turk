# Mecha Turk

**Documentation: <https://shaunburdick.github.io/mecha-turk/>** — what Mecha
Turk is and is not, and how to install, configure, use, and debug it.

**GitHub work in, OpenChamber sessions out.** Mecha Turk watches the GitHub
repositories you bind to it for work meant for your accounts — issues assigned
to you, review requests, and mentions — and turns each discovery into an
OpenChamber agent session, keeping a durable record of every detection and every
dispatch.

It is an [OpenChamber](https://docs.openchamber.dev) extension — a rail panel
plus a local service — and **it runs on your own OpenChamber installation**:
polling, storage, and dispatch all happen on your own machine, with no hosted
control plane and no GitHub write access. Installing asks OpenChamber for the
`sessions` and `prompt` capabilities, plus the `service` capability the local
service implies; the install page carries what each one means.

## Development

```sh
npm ci           # toolchain
npm run verify   # build → lint → typecheck → test
```

The panel and service bundles (`panel/main.js`, `service/main.js`) are
committed — OpenChamber never compiles TypeScript on install. Rebuild and
commit them with any source change. See [AGENTS.md](AGENTS.md) for the
layout, invariants, and contributor workflow.

The documentation site in `site/` is a separate subproject — its own lockfile,
its own Node floor, and its own gate — so `npm run verify` does not reach it.
Its commands are in [its quickstart](specs/007-homepage-docs/quickstart.md).

## License

MIT — see [LICENSE](LICENSE).
