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

1. [Install the plugin](#installation) and add a `KWDB TSDB` data source.
2. Configure the KWDB host, port, database, user, and password.
3. Click **Save & test**.
4. Create a dashboard and add a panel using the KWDB data source.
5. Choose a query mode and refresh the panel.

## Requirements

- Grafana 13.1 or newer (built with 13.2.4; E2E-tested on 13.1, 13.2, 13.3 and nightly)
- KWDB with a PostgreSQL-compatible endpoint (default port `26257`)
- A database account with read access; a dedicated read-only account is recommended

## Installation

The plugin ships as a ZIP archive on the [GitHub releases page](https://github.com/KWDB/kwdb-grafana-plugin/releases). Each release contains `kwdb-tsdb-datasource-<version>.zip` (frontend, backend binaries for Linux/macOS/Windows, manifest) plus `.sha1` and `.sha256` digests.

Releases are currently **unsigned**, because the signing step in the release workflow is skipped without `GRAFANA_ACCESS_POLICY_TOKEN`. Grafana refuses to load an unsigned plugin until its ID is on the unsigned-plugin allow list, so complete step 1 first.

### 1. Allow the unsigned plugin

The plugin ID is `kwdb-tsdb-datasource`. Use whichever option matches your install:

- **DEB/RPM package (systemd):** add to the environment file (`/etc/default/grafana-server` on Debian/Ubuntu, `/etc/sysconfig/grafana-server` on RHEL/Rocky; confirm with `systemctl cat grafana-server`):

  ```bash
  GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=kwdb-tsdb-datasource
  ```

- **grafana.ini:**

  ```ini
  [plugins]
  allow_loading_unsigned_plugins = kwdb-tsdb-datasource
  ```

- **Docker:** pass `-e GF_PLUGINS_ALLOW_LOADING_UNSIGNED_PLUGINS=kwdb-tsdb-datasource`.

Restart Grafana after changing any of these.

### 2. Install the ZIP

Download the release and verify it. The commands below use `v1.5.0` as an example; substitute the version you are installing:

```bash
cd /tmp
curl -LO https://github.com/KWDB/kwdb-grafana-plugin/releases/download/v1.5.0/kwdb-tsdb-datasource-1.5.0.zip
curl -LO https://github.com/KWDB/kwdb-grafana-plugin/releases/download/v1.5.0/kwdb-tsdb-datasource-1.5.0.zip.sha256
sha256sum -c kwdb-tsdb-datasource-1.5.0.zip.sha256
```

**Option A — `grafana-cli` from the release URL (recommended).** The supported path while the plugin is not in the Grafana catalog; it handles the download, checksum and directory layout:

```bash
sudo grafana-cli plugins install 1.5.0 \
  --pluginUrl https://github.com/KWDB/kwdb-grafana-plugin/releases/download/v1.5.0/kwdb-tsdb-datasource-1.5.0.zip
```

The version argument must match `info.version` inside the archive.

**Option B — manual unzip** (offline machines). The default plugin directory is `/var/lib/grafana/plugins`; check `[paths] plugins` in `grafana.ini` if yours differs:

```bash
cd /var/lib/grafana/plugins
sudo unzip -o /tmp/kwdb-tsdb-datasource-1.5.0.zip
sudo chmod +x kwdb-tsdb-datasource/gpx_*
```

Two details decide whether Grafana finds the plugin at all:

- The directory must be named exactly `kwdb-tsdb-datasource`, matching the plugin ID. The archive already contains that top-level directory, so unpack it into the plugin root rather than nesting it in another folder of the same name.
- The backend binary needs the execute bit, which a zip can lose when copied across filesystems.

### 3. Restart and verify

```bash
sudo systemctl restart grafana-server
sudo grafana-cli plugins ls
sudo journalctl -u grafana-server -n 50 | grep -i plugin
```

No `unsigned` rejection or `plugin not found` in the log, and **KWDB TSDB** appears under **Connections > Data sources**.

### Upgrading and uninstalling

Remove the directory and install again; never overwrite a plugin directory in place:

```bash
sudo rm -rf /var/lib/grafana/plugins/kwdb-tsdb-datasource
# reinstall, then restart Grafana
```

Uninstalling is the same command without the reinstall step.

### Once the plugin is in the Grafana catalog

After the plugin is published and signed, the allow list is no longer needed and installation collapses to `grafana-cli plugins install kwdb-tsdb-datasource` followed by a restart. Until then, use the release ZIP with `allow_loading_unsigned_plugins` set.

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
- First submissions do not require a signature. Releases published today are **unsigned** because the workflow's signing step is skipped without `GRAFANA_ACCESS_POLICY_TOKEN`, so users must add the plugin ID to `allow_loading_unsigned_plugins` (see [Installation](#installation)). Once a Grafana signature exists, releases are signed and the allow list is no longer needed.
- Full instructions are in the [Grafana plugin publishing guide](https://grafana.com/developers/plugin-tools/publish-a-plugin).

## Support

- Report bugs and request features: [GitHub issues](https://github.com/KWDB/kwdb-grafana-plugin/issues)
- KWDB: <https://www.kaiwudb.com/community>

## License

Apache License 2.0. See [LICENSE](https://github.com/KWDB/kwdb-grafana-plugin/blob/main/LICENSE).
