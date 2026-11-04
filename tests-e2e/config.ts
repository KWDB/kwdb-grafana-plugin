// E2E configuration for the KWDB data source.
//
// Defaults target the demo dataset created by scripts/init.sql (`docker compose up`):
// database demo_ts, table sensors (ts / temperature / humidity / voltage / device_id / location).
//
// The whole suite can be pointed at another KWDB database without touching the tests, e.g.:
//
//   KWDB_E2E_TABLE=example_db.equipment_telemetry \
//   KWDB_E2E_TIME_COLUMN=k_timestamp \
//   KWDB_E2E_COLUMNS='k_timestamp, device_id, current_val' \
//   KWDB_E2E_TAG_COLUMN=device_id \
//   KWDB_E2E_METRIC=current_val \
//   KWDB_E2E_INTERVAL=5m \
//   yarn e2e
//
// Tests that need real data call `skipIfTableUnavailable` and are reported as skipped (not
// passed) when the configured table is missing from the provisioned data source.
export interface E2EConfig {
  /** Qualified table name used in raw SQL, e.g. demo_ts.sensors */
  table: string;
  /** Table name without the database prefix, used for UI option matching */
  tableShortName: string;
  /** Table type shown by the /tables resource, e.g. TIME SERIES TABLE */
  tableType: string;
  /** Exact label the table selector renders for the configured table */
  tableOptionLabel: string;
  timeColumn: string;
  columns: string[];
  tagColumn: string;
  metric: string;
  interval: string;
  /** Dashboard time range used by builder queries (relative times keep CI and live runs working) */
  from: string;
  to: string;
  /**
   * Range used by the gapfill builder test. KWDB's gapfill/imputation aggregate
   * is much slower than plain downsampling, so the default is intentionally
   * short; widen it with KWDB_E2E_GAPFILL_FROM/TO when a data source has a
   * higher queryTimeout.
   */
  gapfillFrom: string;
  gapfillTo: string;
  /**
   * Adversarial table seeded by scripts/init.sql. It stores the shapes that break
   * plugin-side logic rather than the database: a hole wider than the bucket, rows
   * written out of order, a NULL metric, and tag values with commas/quotes/Unicode.
   * Specs that need it skip themselves when it is absent, so pointing the suite at
   * another database stays possible.
   */
  edgeTable: string;
  edgeTableShortName: string;
  edgeTimeColumn: string;
  edgeMetric: string;
  edgeTagColumn: string;
  /** Range that covers the whole edge dataset; it is seeded relative to `now()`. */
  edgeFrom: string;
  edgeTo: string;
}

export const INTERVAL_PRESETS = ['1m', '5m', '15m', '1h', '6h', '1d'];

function envValue(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function parseColumns(value: string): string[] {
  return value
    .split(',')
    .map((column) => column.trim())
    .filter(Boolean);
}

const table = envValue('KWDB_E2E_TABLE') ?? 'demo_ts.sensors';
const tableShortName = table.split('.').pop() ?? table;
const tableType = envValue('KWDB_E2E_TABLE_TYPE') ?? 'TIME SERIES TABLE';
// The edge dataset lives in the same database as the primary table, so pointing the
// suite at another database keeps the pair consistent.
const database = table.includes('.') ? table.slice(0, table.lastIndexOf('.')) : '';
const edgeTableShortName = envValue('KWDB_E2E_EDGE_TABLE') ?? 'edge_cases';

export const e2eConfig: E2EConfig = {
  table,
  tableShortName,
  tableType,
  tableOptionLabel: `${tableShortName} (${tableType})`,
  timeColumn: envValue('KWDB_E2E_TIME_COLUMN') ?? 'ts',
  columns: parseColumns(envValue('KWDB_E2E_COLUMNS') ?? 'ts, device_id, temperature'),
  tagColumn: envValue('KWDB_E2E_TAG_COLUMN') ?? 'device_id',
  metric: envValue('KWDB_E2E_METRIC') ?? 'temperature',
  interval: envValue('KWDB_E2E_INTERVAL') ?? '5m',
  from: envValue('KWDB_E2E_FROM') ?? 'now-30d',
  to: envValue('KWDB_E2E_TO') ?? 'now',
  gapfillFrom: envValue('KWDB_E2E_GAPFILL_FROM') ?? 'now-1d',
  gapfillTo: envValue('KWDB_E2E_GAPFILL_TO') ?? 'now',
  edgeTable: database ? `${database}.${edgeTableShortName}` : edgeTableShortName,
  edgeTableShortName,
  edgeTimeColumn: envValue('KWDB_E2E_EDGE_TIME_COLUMN') ?? 'ts',
  edgeMetric: envValue('KWDB_E2E_EDGE_METRIC') ?? 'value',
  edgeTagColumn: envValue('KWDB_E2E_EDGE_TAG_COLUMN') ?? 'device_id',
  // The dataset is seeded between 60 minutes ago and now.
  edgeFrom: envValue('KWDB_E2E_EDGE_FROM') ?? 'now-90m',
  edgeTo: envValue('KWDB_E2E_EDGE_TO') ?? 'now',
};
