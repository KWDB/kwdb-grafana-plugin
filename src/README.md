# KWDB Grafana data source plugin

This plugin connects [Grafana](https://grafana.com) to KWDB. It executes read-only SQL against the KWDB time-series engine through the PostgreSQL wire protocol and renders results as Grafana time series or table data.

> 本插件适用于 KWDB，可以在 Grafana 中查询、展示和分析 KWDB 时序数据。

![KWDB dashboard example](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/example.png)

## Features

- Visual SQL builder for downsampling, gapfill, latest values, and window/event queries, plus a raw SQL editor.
- Time-series and table output formats with automatic KWDB type conversion.
- Table and column metadata browsing, including `TIME SERIES TABLE` vs `TABLE` detection.
- Backend health check, Grafana Alerting, and annotation queries.
- Read-only guard rails: a read-only statement check, connection-level read-only transactions, a per-statement timeout and a row cap.
- TLS root certificate support for `verify-ca` and `verify-full`.
- Result rows are capped at 100,000 per frame with a warning notice on truncation.

## Quick start

1. Install the plugin and add a `KWDB TSDB` data source.
2. Configure the KWDB host, port, database, user, and password.
3. Click **Save & test**.
4. Create a dashboard and add a panel using the KWDB data source.
5. Choose a query mode and refresh the panel.

## Requirements

- Grafana 13.1 or newer (built with 13.2.4; E2E-tested on 13.1, 13.2, 13.3 and nightly)
- KWDB with a PostgreSQL-compatible endpoint (default port `26257`)
- A database account with read access; a dedicated read-only account is recommended

## Installation

- **From the Grafana plugin catalog:** install `kwdb-tsdb-datasource`, then add a `KWDB TSDB` data source.
- **With grafana-cli:** `grafana-cli plugins install kwdb-tsdb-datasource`, then restart Grafana.
- **From a ZIP:** build and sign the plugin, rename `dist` to the plugin ID, create a ZIP, and extract it into Grafana's plugin directory. See the [packaging guide](https://grafana.com/developers/plugin-tools/publish-a-plugin/package-a-plugin).

## Configuration

| Field           | Description                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Host            | KWDB host, for example `10.0.0.10`.                                                                                       |
| Port            | PostgreSQL-compatible port, default `26257`.                                                                              |
| Database        | Database to query, default `defaultdb`.                                                                                   |
| User            | Database user, default `root`. Prefer a read-only account.                                                                |
| SSL Mode        | `disable`, `require`, `verify-ca`, or `verify-full`.                                                                      |
| SSL Root Cert   | Path to the CA certificate for `verify-ca` / `verify-full`.                                                               |
| Password        | Database password, stored in Grafana secure JSON data.                                                                    |
| Query timeout   | Per-statement timeout in seconds (default `30`, `-1` disables). Applied as both `statement_timeout` and a query deadline. |
| Max rows        | Rows buffered per frame (default `100000`, `-1` disables). The query is cancelled once the cap is reached.                |
| Max connections | Connection pool size (default `8`).                                                                                       |
| Connect timeout | Connection timeout in seconds (default `5`).                                                                              |
| Max lifetime    | Maximum lifetime of a pooled connection in seconds (default `3600`).                                                      |
| Max idle time   | Seconds a connection may sit idle before it is closed (default `900`).                                                    |

![Data source settings](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/kwdb-datasource.png)

Click **Save & test** to verify connectivity. The backend executes `SELECT 1` and reports whether the data source is working.

![Save and test](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/save-test.png)

## Query editor

The query editor provides five modes:

- **Downsampling** aggregates metrics with `time_bucket`.
- **Gapfill** fills time gaps with `time_bucket_gapfill` and interpolation.
- **Latest values** returns the latest row per tag set.
- **Window/Event** supports `TIME_WINDOW`, `SESSION_WINDOW`, `EVENT_WINDOW`, `COUNT_WINDOW`, and `STATE_WINDOW`.
- **Raw SQL** accepts read-only `SELECT`, `SHOW`, `EXPLAIN`, or `WITH` statements.

Each visual mode generates SQL automatically and shows a read-only SQL preview.

### Downsampling

Select a table, time column, interval, tag columns for `GROUP BY`, and one or more metrics. Aggregations: `avg`, `sum`, `count`, `min`, `max`, `stddev`, `none`.

![Downsampling example](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/downsampling-example.png)

### Gapfill

Supported interpolation modes, matching KWDB's accepted values: `linear`, `prev`, `next`, `null`, and `constant` (fills gaps with the numeric value entered next to the mode). `interpolate` accepts a lower-case quoted method name or a numeric constant; queries generated by older plugin versions that stored `PREV`/`NEXT`/`NULL` are normalised to the lower-case form automatically.

### Latest values

Supported functions: `last`, `last_row`, `first`, `first_row`. The time column follows the selected function, so the plotted value and its timestamp always refer to the same row. Results are split into one series per tag combination, so Stat and Gauge panels display one value per device; disable the **Split per tag** toggle to return a single merged table frame instead.

### Raw SQL

```sql
SELECT ts, voltage_v, station_code
FROM charger_data
WHERE $__timeFilter(ts)
ORDER BY ts
LIMIT 100
```

Available macros:

| Macro                              | Expansion                                                     |
| ---------------------------------- | ------------------------------------------------------------- |
| `$__timeFilter(column)`            | `(column >= '...'::TIMESTAMP AND column <= '...'::TIMESTAMP)` |
| `$__timeFrom`                      | Dashboard time range start as a timestamp literal             |
| `$__timeTo`                        | Dashboard time range end as a timestamp literal               |
| `$__timeGroup(column, 'interval')` | `time_bucket(column, 'interval')`                             |

## Output formats

- **Time series**: the backend finds the time column, sorts by time, converts tag columns into labels, and produces a wide time-series frame with one series per tag combination. Choose this for chart panels such as **Time series**, **Stat**, and **Gauge**.
- **Table**: the result is returned as raw rows. Choose this for the **Table** panel. Latest-values queries with tag columns additionally return one frame per tag combination by default.

Result rows are capped at 100,000 rows per frame. When the cap is reached, the frame includes a warning notice.

## Read-only safety

Read-only access is enforced in three layers:

1. **Statement check (guard rail).** The backend only allows statements starting with `SELECT`, `SHOW`, `EXPLAIN`, or `WITH`. It rejects multi-statement SQL (including statements hidden behind `E'...'` escape strings), `SELECT INTO`, DML inside `WITH`, write keywords, and `SHOW` forms that expose cluster or session state. Keywords inside string literals, quoted identifiers, dollar quoting and comments are ignored. Functions with side effects or unbounded blocking (`kwdb_internal.*`, `pg_sleep`, `pg_read_file`, `nextval`, `set_config`, ...) are rejected by name.
2. **Connection-level read-only mode.** Every pooled connection starts with `default_transaction_read_only = on` and a `statement_timeout`, so even a statement that slips past the check cannot write, and a runaway query is cancelled.
3. **Database account permissions.** Use a dedicated account that only has `SELECT` privileges. The account is the real boundary; never connect with `root` in a shared Grafana.

## Security recommendations

- Connect with a dedicated read-only account rather than `root`.
- Use `sslMode=verify-full` with `sslRootCert` whenever Grafana and KWDB are not on the same trusted host.
- Keep the default `Query timeout` unless a dashboard genuinely needs longer scans.
- Error messages returned to Grafana include the database message (for example a SQLSTATE) so users can fix their queries; connection URLs are redacted.

## Troubleshooting

- **Health check fails:** verify the KWDB host, port, database, user, and password, confirm the port is reachable from the Grafana backend, and check KWDB account permissions.
- **Table list is empty:** confirm the configured database exists and that the account can run `SHOW TABLES`.
- **Results are truncated:** the backend caps results at 100,000 rows per frame (configurable). Add `LIMIT` or narrow the time range.
- **Queries time out:** the default statement timeout is 30 seconds. Note that `time_bucket_gapfill` + `interpolate` is much slower than plain downsampling: on a multi-million-row table a 30 day gapfill can exceed 30 seconds while the same range downsamples in well under a second.
- **`SHOW` statement is rejected:** `SHOW` is allowed for schema and session variables, but forms that expose cluster or session state are blocked (`SHOW SESSIONS`, `SHOW QUERIES`, `SHOW JOBS`, `SHOW TRACE`, `SHOW STATISTICS`, `SHOW BACKUP`, `SHOW ALL`, `SHOW SCHEDULES`, `SHOW CHANGEFEEDS`).
- **Window queries fail with `group-window-func: memory budget exceeded`:** sliding windows (`TIME_WINDOW` with a slide interval) and `COUNT_WINDOW` buffer every row of the range in memory, so a long dashboard time range exhausts KWDB's window memory budget. This is a database-side limit, not a plugin one. Narrow the panel time range, or drop the slide interval so the window boundaries line up with the range instead of overlapping.
- **Annotation queries return nothing:** Grafana derives annotation events from a `time` column plus a text column, so an annotation query has to use **Table** format. A builder query in Time series format fails with `could not convert frame to time series` because its result has no text column.

## Development and publishing

- See [DEVELOPMENT.md](https://github.com/KWDB/kwdb-grafana-plugin/blob/main/DEVELOPMENT.md) for local development, testing, and packaging instructions.
- Plugin ID: `kwdb-tsdb-datasource`. It follows the `org-name-type` convention the
  catalog validator enforces (at least three hyphen-separated parts), where
  `kwdb` is the Grafana Cloud organization slug.
- First submissions do not require a signature. After review, versions are signed and released through the `Release` GitHub Actions workflow.
- Full instructions are in the [Grafana plugin publishing guide](https://grafana.com/developers/plugin-tools/publish-a-plugin).

## Support

- Report bugs and request features: [GitHub issues](https://github.com/KWDB/kwdb-grafana-plugin/issues)
- KWDB: <https://www.kaiwudb.com/community>

## License

Apache License 2.0. See [LICENSE](https://github.com/KWDB/kwdb-grafana-plugin/blob/main/LICENSE).
