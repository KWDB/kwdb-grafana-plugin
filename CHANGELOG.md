# Changelog

## Unreleased

### Added

- Dashboard Ad Hoc filters are applied before aggregation for Query Builder
  targets and through a documented wrapper for Raw SQL. The query editor's
  **Ad Hoc table** setting supplies the table used for key suggestions; the new
  `/tag-keys` resource returns its tag columns, and the existing `/tag-values`
  resource returns their values. See #79.
- Browser regression coverage saves temporary dashboards and verifies template
  variables and Ad Hoc filters on the actual panel request path.

### Fixed

- Dashboard and template variables are now interpolated in SQL before it is
  sent to KWDB. Single strings are SQL-escaped, multi-value/`All` values become
  quoted lists, numbers stay numeric, and comments and dollar-quoted strings
  are left untouched. Grafana time macros continue to be expanded by the
  backend. See #78.

## v1.4.1 (2026-10-29)

### Changed

- Plugin ID is now `kwdb-tsdb-datasource`. Submitting v1.4.0 to the catalog
  returned `invalid-id-format`: the validator requires the `org-name-type`
  convention with at least three hyphen-separated parts, and
  `kwdb-datasource` has only two. `kwdb-datasource` was never accepted, so no
  published version changes identity; data sources created from the v1.4.0 ZIP
  have to be recreated after the upgrade.

### Fixed

- Backend: the connection pool size no longer trips gosec `G115`. The clamp was
  applied to a struct field, which gosec does not follow, and the
  `//nolint:gosec` comment that was meant to suppress it only silences
  golangci-lint — the gosec run performed by the catalog validator still
  reported the conversion as HIGH. It is now clamped on a local variable, which
  gosec can follow, so the finding is gone without a `#nosec` directive.
- Backend: `golang.org/x/net` updated from v0.60.0 to v0.62.0, clearing
  GO-2026-6860 and GO-2026-6866. Both were reported by the catalog validator's
  `govulncheck` binary scan of the v1.4.0 archives; the plugin never calls the
  vulnerable `html` symbols, so a source-mode scan was clean while the binary
  scan was not.

## v1.4.0 (2026-10-29)

### Changed

- Plugin ID changed from `lumingsun-kwdbtsdb-datasource` to `kwdb-datasource`,
  matching the company Grafana Cloud organization `kwdb`. The previous ID was
  never published to the Grafana catalog, so there is no catalog upgrade path;
  users of the pre-release ZIP must reinstall the plugin and recreate their data
  sources.

### Fixed

- Release assets carry a `.sha1` checksum again. The Grafana plugin submission
  form asks for the SHA-1 of the archive behind the URL; releases from v1.3.0
  on shipped only `.sha256`, so that value had to be computed by hand before a
  submission. The release workflow now writes `.sha1` and `.sha256` side by
  side, and the missing `.sha1` was added to the already published v1.4.0
  release.

## v1.3.0 (2026-10-29)

### Added

- Unit tests for the SQL builder and the template variable query parser: all
  five builder modes, identifier quoting, window/event argument validation and
  the parse/render round trip.
- Unit tests for the field reset applied when the table or the window type
  changes, the variable support class, the health check error classification and
  the connection settings validation.
- End-to-end tests for the latest values and window/event builder modes and for
  annotation queries (12 new cases). The suite runs in CI against a KWDB
  container seeded by `scripts/init.sql` and passes on Grafana 13.1, 13.2, 13.3
  and nightly.
- CI now runs the complete Grafana plugin validator (all analyzers) on every
  pull request, with the same command and version as the release workflow.
  Previously only the metadata analyzer ran in CI; the release workflow has run
  the full validator since v1.2.2 (2026-10-28).
- An internal real-server verification report records the end-to-end runs
  against live KWDB instances (addresses and accounts redacted): generated SQL
  statements, the Go backend pipeline, Playwright specs, the alerting path and
  the TLS modes (`require`, `verify-ca`, `verify-full`, plus plaintext
  rejection). The report is not published in this repository.
- `RoadMap.md` / `RoadMap_en.md` describe the release plan and the items that
  are explicitly out of scope.
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md` and GitHub issue / PR
  templates.

### Changed

- The data source registers its template variable editor and query
  implementation through the `variables` property of the data source instance;
  the deprecated `DataSourcePlugin.setVariableQueryEditor` is no longer used.
- Health check failures are prefixed with a short classification (authentication
  failed, database does not exist, connection timed out, TLS negotiation
  failed, ...). The original database error, including its SQLSTATE, is still
  shown.
- Connection settings are validated before the pool is created: the port must
  be in 1-65535 and `sslmode` only accepts the four modes offered by the
  configuration page.
- The constant interpolation fill value is emitted as a quoted string
  (`interpolate(avg(col), '0')`), the form used in the KWDB documentation,
  instead of a bare numeric literal.
- `plugin.json` links point at the renamed repository and the plugin declares
  `category: tsdb` for the Grafana connection directory.
- The release workflow verifies that the pushed tag matches the version in
  `package.json`, writes a SHA-256 checksum for the archive and warns when the
  CHANGELOG has no section for the version instead of silently falling back.
- Documentation: the README troubleshooting section covers the KWDB window
  memory budget and the requirement that annotation queries use Table format.

### Fixed

- SQL builder: the SELECT list and the WHERE clause now quote the same
  identifier when the time column or a metric column contains leading or
  trailing whitespace, and a blank interval falls back to the 5m default.
- SQL builder: a schema-qualified table name that contains a dot inside quotes
  (for example `"my.table"`) is no longer rewritten into two identifiers.
- SQL builder: selecting `none` as the aggregation no longer produces a
  statement the database rejects. Non-aggregated metric columns are added to the
  GROUP BY list; for window queries they are placed before the window
  expression, because KWDB requires a grouped window function to be the last
  GROUP BY entry.
- SQL builder: `COUNT_WINDOW` falls back to a row limit of 100, the value the
  "Row limit" field shows. Previously a newly selected `COUNT_WINDOW` generated
  an empty statement while the field read 100.
- SQL builder: a latest-values query without tags now produces a frame whose
  first field is the time column, so Grafana keeps treating it as a time series.
- SQL builder: gapfill no longer offers `none` (interpolate() requires an
  aggregate) and coerces a value left over from an older query to `avg`.
- Time macros are no longer expanded inside string literals, quoted identifiers
  or comments; nested macro calls are expanded from the inside out.
- Template variable queries accept quoted arguments that contain a comma,
  reject parentheses in identifiers, and always render a definition the plugin
  can parse back. A trailing semicolon separated from the query by whitespace no
  longer produces a misleading "unsupported variable query" error.
- Structured variable queries are validated for every query type and returned as
  a copy, so a caller can no longer mutate the parsed result.
- The annotation end-to-end tests match the query request by the generated SQL
  instead of the annotation picker.

### Security

- Window/event free-form arguments are validated in the builder: event and state
  conditions that could terminate the statement or open a comment are rejected,
  and `COUNT_WINDOW` limits must be positive integers.
- `sslmode` values that pgx would silently downgrade to a plaintext connection
  (`allow`, `prefer`) are rejected.
- The Go toolchain baseline is now 1.26.10 and `golang.org/x/net` is upgraded to
  v0.60.0, clearing the standard-library and HTTP/2 advisories reported by
  `govulncheck`; the dependency scan is blocking in CI and in the release
  workflow again.

## v1.2.2 (2026-10-27)

### Changed

- The packaged plugin README now ships the full user documentation (query editor
  modes, time macros, output formats, read-only safety, troubleshooting) instead
  of the short summary, so the Grafana plugin catalog page shows the complete
  guide.
- `plugin.json` adds four screenshots (dashboard example, data source
  configuration, downsampling query, save & test) and `License` / `Support`
  links for the catalog detail page.

## v1.2.1 (2026-10-22)

### Security

- Every pooled connection now starts with `default_transaction_read_only = on`
  and a `statement_timeout` (default 30s, configurable), so a statement that
  slips past the lexical check still cannot write and runaway queries are
  cancelled.
- The read-only guard now understands `E'...'` escape strings, dollar quoting
  and nested block comments, closing a multi-statement bypass, and rejects
  internal management catalogs (`kwdb_internal.*`, `crdb_internal.*`) and
  side-effecting functions (`pg_sleep`, `pg_read_file`, `nextval`,
  `set_config`, ...).
- `SHOW` is restricted to schema-oriented forms so cluster/session state is not
  exposed.
- Connection URLs in error messages are redacted; read-only and TLS guidance was
  added to the README.

### Fixed

- `$__timeFilter` and `$__timeGroup` now expand through a paren-matching
  scanner: `CAST(...)` and nested function arguments no longer produce broken
  SQL, and every expansion is parenthesised so `NOT $__timeFilter(x)` keeps its
  meaning.
- Reaching the row cap now cancels the running query instead of draining the
  whole result set.
- Database errors raised while scanning rows are reported as downstream errors
  instead of plugin errors.
- Gapfill `constant` mode now emits a numeric constant; interpolation modes use
  KWDB's accepted lower-case names (legacy `PREV`/`NEXT`/`NULL` values are
  normalised).
- Latest-values queries use `first()`/`last()` for the time column to match the
  selected function, so values and timestamps no longer disagree.
- `date` columns map to Grafana time fields, and `uuid`/`interval`/`time` values
  render as readable strings instead of Go representations.
- A time series query now fails with a clear message when the configured time
  column is missing or contains `NULL` values.
- Metadata parsing ignores table-level clauses (`INDEX`, `CONSTRAINT`,
  `FOREIGN KEY`, ...) so the column picker no longer offers phantom columns.
- Template-variable tag values are capped at 10,000 entries.
- An empty query returns an explicit "query is empty" message instead of a
  read-only rejection.

### Changed

- `queryTimeout` and `maxRows` can be configured per data source.
- `plugin.json` no longer declares `queryOptions` that were never read, and the
  minimum Grafana version is 13.1.0 (the version the plugin is built and tested
  against).

## [v1.2.0](https://github.com/KWDB/kwdb-grafana-plugin/tree/v1.2.0) (2026-08-25)

[Full Changelog](https://github.com/KWDB/kwdb-grafana-plugin/compare/v1.1.0...v1.2.0)

## [v1.1.0](https://github.com/KWDB/kwdb-grafana-plugin/tree/v1.1.0) (2026-08-10)

[Full Changelog](https://github.com/KWDB/kwdb-grafana-plugin/compare/v1.0.0...v1.1.0)

- Fix sql preview [\#12](https://github.com/KWDB/kwdb-grafana-plugin/pull/12) ([LumingSun](https://github.com/LumingSun))

## [v1.0.0](https://github.com/KWDB/kwdb-grafana-plugin/tree/v1.0.0) (2026-08-06)

[Full Changelog](https://github.com/KWDB/kwdb-grafana-plugin/compare/6d2886713db4b6cdd8897f2246376a8be56347d5...v1.0.0)

\* _This Changelog was automatically generated by [github_changelog_generator](https://github.com/github-changelog-generator/github-changelog-generator)_
