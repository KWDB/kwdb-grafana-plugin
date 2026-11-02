# RoadMap

This file tracks the development plan for the KWDB TSDB Grafana data source plugin. It only lists work that has been decided on.

## Current version

**v1.4.1** — released (2026-10-29), awaiting review for the Grafana plugin catalog.

v1.4.x is a catalog-readiness line: it contains no feature or UX changes relative to v1.3.0. The work went into the plugin ID, the release pipeline and dependency upgrades — the ID is now `kwdb-tsdb-datasource`, in the three-part `org-name-type` form the validator requires, and the repository lives under the `KWDB` organization. The feature baseline is still v1.3.0.

Shipped capabilities: five query editor modes (downsampling, gapfill interpolation, latest values, window/event, raw SQL), Grafana standard time macros, three layers of read-only protection, full KWDB time-series feature coverage (`time_bucket`, `time_bucket_gapfill` with five interpolation modes, four latest-value functions, five window functions), four TLS modes, 13 configurable connection parameters, table/column/tag-value browsing, query template variables, a 100,000 row per frame cap with a truncation notice, and full end-to-end verification against a real KWDB instance (including the TLS scenarios).

## v1.3.0 — release wrap-up (done)

| Item                                         | Notes                                                                                                                                                                                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full plugin-validator in CI                  | CI now runs the full validator on pull requests. It previously ran `metadatavalid` only; the release workflow has executed and passed the same command since v1.2.2 (2026-10-28, run 40614631903)                                                                      |
| Classified health check errors               | Authentication failure, missing database, timeouts and TLS problems now get a human-readable hint; the raw SQLSTATE is preserved                                                                                                                                       |
| Connection parameter validation              | Port range and an sslMode allowlist (pgx's `allow`/`prefer` silently downgrade to plaintext and are rejected)                                                                                                                                                          |
| Variable support API migration               | `setVariableQueryEditor` is deprecated; replaced with the `variables` property on the data source instance                                                                                                                                                             |
| Unit tests for the core logic                | SQL generation and variable query parsing now have unit tests; `sqlBuilder` reports 100% statements / 95.5% branches and `variableQuery` 100% statements / branches / functions                                                                                        |
| Defects found by the tests                   | 14 of 15 fixed; the remaining item (window expression in the SELECT list) is a product decision and is listed under the backlog below                                                                                                                                  |
| e2e for latest values / window / annotations | 12 new cases                                                                                                                                                                                                                                                           |
| Real-server end-to-end verification          | 2026-10-29 on a real KWDB instance (1M-row time-series table): 56 generated SQL statements, the Go backend pipeline, 21/21 e2e specs and the manual alerting path. Addresses and credentials are redacted; the report is internal and not published in this repository |
| TLS end-to-end verification                  | `require`, `verify-ca`, `verify-full`, a foreign CA and plaintext rejection for a non-administrative account were all exercised; see section 6 of the internal report                                                                                                  |
| `interpolate` constant mode syntax           | `'constant'` is not in KWDB's interpolation allowlist (returned 400 on a live instance on 2026-10-22); it now emits the quoted constant `interpolate(avg(v), '0')`, pinned by a unit test                                                                              |

## Backlog

### Features and UX

| Item                                                        | Kind               | Notes                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cascading template variables                                | Bug                | `metricFindQuery` needs `getTemplateSrv().replace()`, otherwise `tag_values($schema.$table, $col)` does not resolve                                                                                                                                                 |
| `none` aggregation row explosion                            | UX                 | 32,136 rows instead of 72 for a 6-hour window. Valid SQL but it floods the chart; drop `none` from downsampling or rename it and warn                                                                                                                               |
| Window interval validation                                  | UX                 | Docs require `TIME_WINDOW` intervals >= 10ms over ms..year and `SESSION_WINDOW` thresholds in s/m/h/d/w; the editor does not validate, so `500us` surfaces a database error                                                                                         |
| `EVENT_WINDOW` reachable end condition                      | UX / docs          | An end condition that never becomes true silently returns 0 rows, contradicting the local 3.2.1 docs; needs a hint in the editor or the docs                                                                                                                        |
| Window expression in the SELECT list                        | Product decision   | The window expression currently only appears in `GROUP BY`, so the result set cannot tell which window a row belongs to. All five window functions work on a live KWDB, so this is a usability improvement that would change the output shape of every window query |
| Query editor help                                           | UX                 | A one-click formatter and a cheat sheet for raw SQL mode                                                                                                                                                                                                            |
| `Select`/`MultiSelect`/`VerticalGroup` → `Combobox`/`Stack` | Deprecation        | These `@grafana/ui` 13 components are deprecated. Ten files are affected and the e2e selectors change with them                                                                                                                                                     |
| `last` / `last_row` NULL semantics                          | Needs verification | Both take the max-timestamp row per the docs and differ only in NULL handling. Needs a dedicated test with a nullable metric whose last row is NULL; `last_row_ts()` is a candidate                                                                                 |
| `last_row` time column consistency                          | Needs verification | The value/timestamp mismatch is fixed (the time column follows `latestFunc`). What remains is the `last()` vs `last_row()` difference when the time column is nullable                                                                                              |
| Automated alert rule test case                              | Test coverage      | The manual path works (section 5 of the internal report), but "create rule -> fire -> receive notification" still has no automated e2e coverage                                                                                                                     |
| `.config/` naming leftovers                                 | Optional clean-up  | The log filter was aligned with the real plugin ID in v1.4.1; `container_name`, the mount paths and the supervisord directory names still use the scaffold-time name. Cosmetic only; regenerate `.config/` and re-verify the dev environment when touching it       |

## Decisions needed outside the repository

These do not block merging code, but they affect how released versions are maintained:

- **Signing token.** `GRAFANA_ACCESS_POLICY_TOKEN` is not configured in the repository secrets, so release artifacts are currently unsigned. The first submission may be unsigned, but every version after approval must be signed.
- **Branch protection.** main has no required status checks or required review, so CI results are advisory rather than a gate.

## Long term

- Richer annotations: the default Grafana implementation is used today; a native annotation source built on KWDB event windows is possible later.
- Query performance: pool defaults are in place; per-query-type timeout strategies need real workload data before being decided.

---

## Explicitly out of scope

- **Multi-statement queries.** The read-only guard rejects them on purpose. This is a security boundary and will not be relaxed for convenience.
- **A dedicated editor for relational tables.** Raw SQL mode already covers this; relational model queries belong on the Text2SQL side.
- **Grafana 12 and older.** `grafanaDependency` is `>=13.1.0`; no back-porting.
