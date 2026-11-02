# Contributing

Thanks for contributing to the KWDB TSDB Grafana data source. This project is an
open-source Grafana data source plugin for KWDB's time-series engine. Bug
reports, feature requests, documentation fixes, and focused pull requests are
welcome.

## Reporting issues

- Search the existing issues first, then use the bug report or feature request
  issue form.
- Include the Grafana version, KWDB version, plugin version, and deployment
  method when they are relevant, along with clear reproduction steps.
- Redact passwords, tokens, private keys, certificate contents, internal
  hostnames and IP addresses, and customer data from logs, screenshots, and
  query examples.
- Do **not** report security vulnerabilities in a public issue. Follow
  [SECURITY.md](SECURITY.md) and use GitHub Security Advisories.

## Branches and commits

Create a topic branch from the current `main` and keep each branch scoped to
one change:

```text
feat/short-description
fix/short-description
docs/short-description
test/short-description
chore/short-description
ci/short-description
```

Use short, imperative commit messages. Conventional Commit prefixes such as
`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`, and `ci:` are
encouraged. Keep commits reviewable; avoid mixing unrelated refactors with a
behavior change.

## Local development

Prerequisites:

- Node.js 24 (pinned in `.nvmrc`)
- Go 1.26 or newer
- Docker with Docker Compose
- Yarn 1.22.22 via Corepack
- Mage for the backend build targets
- Google Chrome for the default e2e configuration

Install dependencies and start the local stack:

```bash
corepack enable
corepack prepare yarn@1.22.22 --activate
yarn install --frozen-lockfile
docker compose up -d
```

Grafana is available at <http://localhost:3001>. The Compose stack starts KWDB,
seeds demo data, and provisions the data source. See
[DEVELOPMENT.md](DEVELOPMENT.md) for connection overrides and backend details.

## Build and test commands

| Task                 | Command                       |
| -------------------- | ----------------------------- |
| Frontend build       | `yarn build`                  |
| Frontend unit tests  | `yarn test:ci`                |
| TypeScript typecheck | `yarn typecheck`              |
| Frontend lint        | `yarn lint`                   |
| Backend build        | `mage -v build:backend`       |
| Backend unit tests   | `go test ./pkg/...`           |
| Backend vet          | `go vet ./pkg/...`            |
| Backend lint         | `golangci-lint run ./pkg/...` |
| End-to-end tests     | `yarn e2e`                    |

The e2e suite needs the local Grafana stack running and uses
`http://localhost:3001` by default. `mage -v build:backend` builds a binary for
the host platform only; use the Linux build command in
[DEVELOPMENT.md](DEVELOPMENT.md) when testing the Docker image.

## Pull requests

- Keep PRs small and focused. Split unrelated refactors or formatting changes
  into separate PRs.
- Link the issue the PR addresses, for example `Closes #123`; explain the
  problem and the approach when there is no issue.
- Fill in the pull request template: summary, related issue, changes,
  verification commands and results, and risk/rollback.
- Add or update tests for behavior changes, and update documentation for
  user-visible changes.
- Include a screenshot or short recording for UI changes.
- Do not modify `.config/`. Those files are managed by the Grafana plugin tools;
  if a change seems necessary, discuss it in an issue first.
- If `src/plugin.json` changes, restart Grafana and verify the plugin loads with
  the new metadata. Grafana reads plugin metadata at startup.
- Run the relevant build, test, typecheck, and lint commands before requesting
  review. CI runs the build, typecheck, lint, and unit-test checks.
- Make sure the diff contains no secrets, credentials, private keys, real
  certificates, internal hostnames or IP addresses, or customer data.

## Code style

- TypeScript and React live under `src/`; format with Prettier and lint with
  ESLint (`yarn lint`). Follow the existing component and data-source patterns.
- Go code lives under `pkg/`; run `gofmt` and `golangci-lint run ./pkg/...`.
- Keep the backend query path read-only. Changes to SQL validation or execution
  need tests covering both accepted and rejected statements.
- Keep documentation in Markdown with fenced code blocks for commands.

## Developer Certificate of Origin

This project does **not** require a `Signed-off-by` trailer or a CLA. By
submitting a pull request you confirm that you have the right to contribute the
code under the Apache-2.0 license used by this repository.

## License

This project is licensed under the Apache License 2.0. See [LICENSE](LICENSE).
By submitting a contribution, you agree that it may be distributed under that
license.
