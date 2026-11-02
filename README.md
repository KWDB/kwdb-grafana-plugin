# KWDB Grafana Data Source Plugin

This plugin connects [Grafana](https://grafana.com) to KWDB. It executes
read-only SQL against the KWDB time-series engine through the PostgreSQL wire
protocol and renders results as Grafana time series or table data.

> 本插件适用于 KWDB，可以在 Grafana 中查询、展示和分析 KWDB 时序数据。

![example](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/example.png)

## Features

- Visual SQL builder for downsampling, gapfill, latest values, and window/event
  queries, plus a raw SQL editor.
- Time-series and table output formats with automatic KWDB type conversion.
- Table and column metadata browsing, including `TIME SERIES TABLE` vs `TABLE`
  detection.
- Backend health check, Grafana Alerting, and annotations.
- Read-only guard rails: a read-only statement check, connection-level
  read-only transactions, a per-statement timeout and a row cap.
- TLS root certificate support.
- 100,000-row result cap with a warning notice; the query is cancelled when the
  cap is reached.

## Quick Start

1. Install the plugin and add a `KWDB TSDB` data source.
2. Configure the KWDB host, port, database, user, and password.
3. Click **Save & test**.
4. Create a dashboard and add a panel using the KWDB data source.
5. Choose a query mode and refresh the panel.

## Requirements

- Grafana 13.1 or newer
- KWDB with a PostgreSQL-compatible endpoint (default port `26257`)
- A database account with read access; prefer a dedicated read-only account

| Component        | Requirement                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| Grafana          | 13.1 or newer (built with 13.2.4; E2E-tested on 13.1, 13.2, 13.3 and nightly) |
| KWDB             | PostgreSQL-compatible endpoint, default port `26257`                          |
| Database account | Read access; a dedicated read-only account is recommended                     |

## Installation

### Grafana plugin catalog

Install `kwdb-tsdb-datasource` from the Grafana plugin catalog once it is
published, then add a `KWDB TSDB` data source.

### grafana-cli

When the plugin is published, install it from the command line:

```bash
grafana-cli plugins install kwdb-tsdb-datasource
```

Restart Grafana after installation.

### Manual ZIP installation

1. Build and sign the plugin.
2. Rename `dist` to `kwdb-tsdb-datasource`.
3. Create a ZIP archive.
4. Extract it into Grafana's plugin directory.
5. Restart Grafana.

See the
[Grafana plugin packaging guide](https://grafana.com/developers/plugin-tools/publish-a-plugin/package-a-plugin).

### Local development environment

The repository includes a Docker Compose stack that starts KWDB, seeds the
`demo_ts.sensors` table, provisions the `KWDB TSDB` data source, and loads a
demo dashboard:

```bash
docker compose up -d
```

Grafana is available at `http://localhost:3001` by default. Override the port
with `GRAFANA_PORT`.

To point the provisioned data source at an existing KWDB instance:

```bash
KWDB_HOST=db.example.com KWDB_PORT=26257 KWDB_DATABASE=example_db \
  docker compose up -d --no-deps grafana
```

## Configuration

1. Open Grafana and navigate to **Connections** > **Data sources**.
2. Click **Add data source**.
3. Search for **KWDB TSDB**.
4. Fill in the connection settings.
5. Click **Save & test**.

![KWDB Datasource](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/kwdb-datasource.png)

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

### TLS/SSL

For `verify-ca` and `verify-full`, provide the CA certificate path in
**SSL Root Cert**. The certificate path is passed to the PostgreSQL connection
as `sslrootcert`.

### Save and test

Click **Save & test** to verify connectivity. The backend executes `SELECT 1`
and reports whether the data source is working.

![test-datasource](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/save-test.png)

## Build a dashboard

1. Create a new dashboard.
2. Add a panel.
3. Select the **KWDB TSDB** data source.
4. Choose a query mode in the query editor.
5. Refresh the panel and verify the data.

## Query editor

The query editor provides five modes:

- **Downsampling**
- **Gapfill**
- **Latest Values**
- **Window/Event**
- **Raw SQL**

Each visual mode generates SQL automatically and shows a read-only SQL preview.
The SQL preview fills the available width and can be resized vertically with
the drag handle below the editor.

### Downsampling

Downsampling aggregates metrics into fixed time buckets with `time_bucket`.
Select a table, time column, interval, tag columns for `GROUP BY`, and one or
more metrics.

Aggregations: `avg`, `sum`, `count`, `min`, `max`, `stddev`, `none`.

![downsampling example](https://github.com/KWDB/kwdb-grafana-plugin/raw/main/src/img/downsampling-example.png)

### Gapfill

Gapfill fills missing time buckets with `time_bucket_gapfill` and
`interpolate`. Supported interpolation modes, matching KWDB's accepted values:

- `linear`
- `prev`
- `next`
- `null`
- `constant` (fills gaps with the numeric value entered next to the mode)

`interpolate` accepts a lower-case quoted method name or a numeric constant.
Queries generated by older plugin versions that stored `PREV`/`NEXT`/`NULL`
are normalised to the lower-case form automatically.

### Latest values

Latest values returns one row per tag set. Supported functions:

- `last`
- `last_row`
- `first`
- `first_row`

The time column follows the selected function: `last`/`last_row` take the last
timestamp of the group, `first`/`first_row` take the first one, so the plotted
value and its timestamp always refer to the same row.

Results are split into one series per tag combination, so Stat and Gauge
panels display one value per device without extra panel configuration:

- With the **Time series** format the backend converts tag columns into
  labels on a single wide frame.
- With the **Table** format the backend returns one frame per tag value,
  keeping every original column so tables still render normally.

Disable the **Split per tag** toggle in the Latest Values editor to return
a single merged table frame instead. As a panel-side alternative, Gauge/Stat
panels can also set **Value options → Show: All values** to expand grouped
rows into one value per device.

### Window/Event

Window/Event queries use KWDB window functions:

- `TIME_WINDOW`
- `SESSION_WINDOW`
- `EVENT_WINDOW`
- `COUNT_WINDOW`
- `STATE_WINDOW`

### Raw SQL

Raw SQL accepts read-only statements that start with `SELECT`, `SHOW`,
`EXPLAIN`, or `WITH`. Multi-statement queries and write statements are
rejected.

Example:

```sql
SELECT ts, voltage_v, station_code
FROM charger_data
WHERE $__timeFilter(ts)
ORDER BY ts
LIMIT 100
```

## Time macros

| Macro                              | Expansion                                                     |
| ---------------------------------- | ------------------------------------------------------------- |
| `$__timeFilter(column)`            | `(column >= '...'::TIMESTAMP AND column <= '...'::TIMESTAMP)` |
| `$__timeFrom`                      | Dashboard time range start as a timestamp literal             |
| `$__timeTo`                        | Dashboard time range end as a timestamp literal               |
| `$__timeGroup(column, 'interval')` | `time_bucket(column, 'interval')`                             |

Timestamp literals carry sub-second precision, but Grafana only provides
millisecond dashboard ranges and KWDB's default `TIMESTAMP` precision is
milliseconds (3 digits). Precision beyond milliseconds is therefore not
available end to end; use a `TIMESTAMP(6)`/`TIMESTAMP(9)` column if you need it.

## Alerting and annotations

The plugin declares Grafana Alerting and annotation support. Both use the same
backend query pipeline and the same read-only guard rails.

Annotation queries are covered by the end-to-end suite. The alerting rule path
is functional but not yet covered by an automated test, so prefer a read-only
account when enabling alerting.

## Output formats

Each query returns one of two formats, selectable in the query editor toolbar
(builder modes default to **Time series** when the value was never set):

- **Time series**: the backend finds the time column, sorts by time, converts
  tag columns into labels, and produces a wide time-series frame with one
  series per tag combination. Choose this for chart panels such as **Time
  series**, **Stat**, and **Gauge** so every device is drawn separately.
- **Table**: the result is returned as raw rows. Choose this for
  the **Table** panel. Latest-values queries with tag columns additionally
  return one frame per tag combination by default, so Gauge/Stat panels still
  show one value per device; disable the **Split per tag** toggle to return a
  single merged table frame.

**Raw SQL** queries keep the format you set explicitly; when it is left unset
a raw query returns its rows as a table so non-time queries keep working.

Result rows are capped at 100,000 rows per frame. When the cap is reached, the
frame includes a warning notice.

## Read-only safety

Read-only access is enforced in three layers. The first two exist so a mistake
in a dashboard cannot modify data; the third is the actual security boundary.

1. **Statement check (guard rail).** The backend only allows statements starting
   with `SELECT`, `SHOW`, `EXPLAIN`, or `WITH`. It rejects multi-statement SQL
   (including statements hidden behind `E'...'` escape strings), `SELECT INTO`,
   DML inside `WITH`, write keywords, and `SHOW` forms that expose cluster or
   session state. Keywords inside string literals, quoted identifiers, dollar
   quoting and comments are ignored. Functions with side effects or unbounded
   blocking (`kwdb_internal.*`, `pg_sleep`, `pg_read_file`, `nextval`,
   `set_config`, ...) are rejected by name.
2. **Connection-level read-only mode.** Every pooled connection starts with
   `default_transaction_read_only = on` and a `statement_timeout`, so even a
   statement that slips past the check cannot write, and a runaway query is
   cancelled.
3. **Database account permissions.** Use a dedicated account that only has
   `SELECT` privileges. The account is the real boundary; never connect with
   `root` in a shared Grafana.

The check is a guard rail, not a sandbox: it is a lexical check, and it is
paired with the read-only transaction so that a parsing mistake cannot become a
write.

## Security recommendations

- Connect with a dedicated read-only account rather than `root`.
- Use `sslMode=verify-full` with `sslRootCert` whenever Grafana and KWDB are not
  on the same trusted host.
- Keep the default `Query timeout` unless a dashboard genuinely needs longer
  scans.
- Error messages returned to Grafana include the database message (for example a
  SQLSTATE) so users can fix their queries; connection URLs are redacted.

## Troubleshooting

### Health check fails

- Verify the KWDB host, port, database, user, and password.
- Confirm the port is reachable from the Grafana backend.
- Check KWDB account permissions.

### TLS handshake fails or plaintext still connects

- `verify-ca` and `verify-full` require the **SSL Root Cert** field to point at
  the CA that signed the node certificate; without it the connection is
  rejected.
- KWDB does not reject plaintext connections for its built-in administrative
  account even when the server was started with `--certs-dir`. To actually
  enforce TLS, connect with a non-administrative account and configure the
  server's HBA to reject non-TLS connections for that account.

### Table list is empty

- Confirm the configured database exists.
- Confirm the account can run `SHOW TABLES`.

### Results are truncated

- The backend caps results at 100,000 rows per frame (configurable).
- Reaching the cap cancels the query, but the panel still only receives the
  buffered rows. Add `LIMIT` or narrow the time range.
- For `Time series` output the cap applies to the rows read before pivoting, so
  the pivoted series can contain fewer points than the cap.

### Queries time out

- The default statement timeout is 30 seconds; raise `Query timeout` in the
  data source settings for heavy scans, or narrow the time range.
- KWDB's `time_bucket_gapfill` + `interpolate` is much slower than plain
  downsampling: on a multi-million-row table a 30 day gapfill can exceed 30
  seconds while the same range downsamples in well under a second. Narrow the
  range or raise the timeout for gapfill panels.

### `SHOW` statement is rejected

- `SHOW` is allowed for schema and session variables, but the forms that expose
  cluster or session state are blocked: `SHOW SESSIONS`, `SHOW QUERIES`,
  `SHOW JOBS`, `SHOW TRACE`, `SHOW STATISTICS`, `SHOW BACKUP`, `SHOW ALL`,
  `SHOW SCHEDULES`, `SHOW CHANGEFEEDS`.

### Window queries fail with `group-window-func: memory budget exceeded`

- Sliding windows (`TIME_WINDOW` with a slide interval) and `COUNT_WINDOW` buffer
  every row of the requested range in memory, so a long dashboard time range
  exhausts KWDB's window memory budget.
- This is a database-side limit, not a plugin one. Narrow the panel time range,
  or drop the slide interval so the window boundaries line up with the range
  instead of overlapping.
- The error is most reproducible on the default 30 day builder range used by the
  end-to-end tests, which is why those tests use a short configurable range.

### Annotation queries return nothing

- Grafana derives annotation events from a `time` column plus a text column, so
  an annotation query has to use **Table** format.
- A builder query left in `Time series` format fails with
  `could not convert frame to time series`, because its result has no text
  column. Set the query format to `Table` before using it as an annotation
  source.

## Development and publishing

- See [DEVELOPMENT.md](DEVELOPMENT.md) for local development, testing, and
  packaging.
- See [RoadMap.md](RoadMap.md) for the release plan and the items that are
  explicitly out of scope.
- Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for the
  development workflow and the pull request checklist.
- To report a security vulnerability, follow [SECURITY.md](SECURITY.md) instead
  of opening a public issue.
- Plugin ID: `kwdb-tsdb-datasource`
- First submissions do not require a signature. After review, versions are
  signed and released through the `Release` GitHub Actions workflow.
- Full publishing instructions:
  [Grafana plugin publishing guide](https://grafana.com/developers/plugin-tools/publish-a-plugin)

## License

Apache License 2.0. See [LICENSE](LICENSE).
