# Development

This file contains development, testing, and packaging instructions for the
KWDB TSDB Grafana data source plugin.

## Prerequisites

- Node.js 24 (the repository pins it in `.nvmrc`)
- Go 1.26 or newer
- Docker and Docker Compose
- Yarn 1.22.22 via Corepack

## Install, build, and test

```bash
yarn install --frozen-lockfile
yarn typecheck
yarn lint
yarn test:ci
yarn build
```

Backend verification:

```bash
go test ./pkg/...
go vet ./pkg/...
golangci-lint run ./pkg/...
```

The backend suite runs without a database. `TestRemoteKWDBIntegration` is
skipped unless `KWDB_TEST_DSN` points at a disposable KWDB instance, for
example:

```bash
KWDB_TEST_DSN='postgres://root@localhost:26257/defaultdb?sslmode=disable' \
  go test ./pkg/... -run Integration -v
```

That test creates and drops its own tables; never point it at a shared
database.

## Local Grafana environment

```bash
docker compose up -d
```

Grafana is exposed on `http://localhost:3001` (override with `GRAFANA_PORT`).
The compose stack starts KWDB, seeds the `demo_ts.sensors` table, provisions the
`KWDB TSDB` data source, and loads the `KWDB TSDB Sensors` demo dashboard.

To point Grafana at an existing KWDB instance:

```bash
KWDB_HOST=db.example.com KWDB_PORT=26257 KWDB_DATABASE=example_db \
  docker compose up -d --no-deps grafana
```

## End-to-end tests

```bash
KWDB_E2E_TABLE=demo_ts.sensors yarn e2e
```

E2E tests live in `tests-e2e/` and default to the provisioned
`demo_ts.sensors` table. Override the table, columns, and metric for another
environment:

```bash
KWDB_E2E_TABLE=ts_db.charger_data \
KWDB_E2E_TIME_COLUMN=ts \
KWDB_E2E_COLUMNS='ts, charger_id, current_amp, voltage_v' \
KWDB_E2E_METRIC=voltage_v \
KWDB_E2E_TAG=charger_id \
yarn e2e
```

The suite also asserts query results through the Grafana API, so a failing
query surfaces as a failed assertion rather than a successful HTTP call.

The local Playwright config uses the system Chrome installation and expects
Grafana on `http://localhost:3001`.

## Cross-platform backend binaries

`mage -v build:backend` only builds a binary for the host platform (Darwin on a
macOS checkout). Build the Linux binary that the Docker container loads:

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build \
  -o dist/gpx_kwdb_tsdb_datasource_linux_arm64 \
  -tags arrow_json_stdlib -ldflags '-w -s' ./pkg
```

The GitHub release workflow builds and packages all platform binaries
automatically.

## Release artifacts

Every release attaches the plugin archive and two checksum files:

- `<plugin-id>-<version>.zip.sha1` — the value the Grafana plugin submission
  form asks for ("SHA1" of the archive URL). A version cannot be submitted to
  the plugin catalog without it.
- `<plugin-id>-<version>.zip.sha256` — the stronger digest, for integrity
  checks and for anyone already verifying against SHA-256.

Both files are written by the `Package plugin` step in
`.github/workflows/release.yml` and listed in the release notes. Keep the
`.sha1` file when touching that step: dropping it breaks plugin registration
even though the build and the validator still pass.
