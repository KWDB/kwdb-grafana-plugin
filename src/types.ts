import { DataSourceJsonData } from '@grafana/data';
import { DataQuery } from '@grafana/schema';

export type KwdbQueryMode = 'downsampling' | 'gapfill' | 'latest' | 'window' | 'raw';

export type KwdbQueryFormat = 'time_series' | 'table';

// KWDB's interpolate() accepts lowercase quoted strings or a numeric constant.
export type KwdbInterpolateMode = 'linear' | 'prev' | 'next' | 'null' | 'constant';

export interface MetricSpec {
  column: string;
  aggregation: 'avg' | 'sum' | 'count' | 'min' | 'max' | 'stddev' | 'none';
  alias?: string;
}

export interface KwdbQuery extends DataQuery {
  mode: KwdbQueryMode;
  // Output format and per-tag frame splitting are consumed by the backend
  // (pkg/plugin/frame.go), never by the SQL builder: they must not change the
  // generated statement.
  format: KwdbQueryFormat;
  // Common fields
  table?: string;
  // Table used by the dashboard Ad Hoc key/value picker. A Raw SQL target has
  // no `table` field, so without this the picker cannot infer one; builder
  // targets default to `table`. Scenes dashboards may also pass their panel
  // targets, in which case those take precedence.
  adHocTable?: string;
  timeColumn?: string;
  tags?: string[];
  metrics?: MetricSpec[];
  // Downsampling / gapfill
  interval?: string;
  // Gapfill
  interpolateMode?: KwdbInterpolateMode;
  // Gapfill: value used when interpolateMode is 'constant' (defaults to 0).
  interpolateConstant?: number;
  // Latest values
  latestFunc?: 'last' | 'last_row' | 'first' | 'first_row';
  // Latest values: split results into one frame per tag combination (default true)
  splitByTag?: boolean;
  // Window / event
  windowType?: 'TIME_WINDOW' | 'SESSION_WINDOW' | 'EVENT_WINDOW' | 'COUNT_WINDOW' | 'STATE_WINDOW';
  windowInterval?: string;
  windowSlide?: string;
  eventStartCond?: string;
  eventEndCond?: string;
  // Raw SQL
  rawSql?: string;
  // Raw SQL last written by the user, kept so switching modes does not lose it.
  customRawSql?: string;
}

export const DEFAULT_QUERY: Partial<KwdbQuery> = {
  mode: 'downsampling',
  format: 'time_series',
  interval: '5m',
  metrics: [{ column: '', aggregation: 'avg' }],
};

export interface KwdbDataSourceOptions extends DataSourceJsonData {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslMode?: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  sslRootCert?: string;
  // Connection pool options; durations are expressed in seconds.
  maxConns?: number;
  maxConnLifetime?: number;
  maxConnIdleTime?: number;
  connectTimeout?: number;
  // Per-statement timeout in seconds (0 = default 30, negative disables) and
  // the per-frame row cap (0 = default 100000, negative disables).
  queryTimeout?: number;
  maxRows?: number;
}

export interface KwdbSecureJsonData {
  password?: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  isTag: boolean;
  isTimeColumn: boolean;
  isPrimaryTag: boolean;
}

export interface TableInfo {
  name: string;
  type: string;
}

// Template variable query: either built by the variable query editor or parsed
// from a raw query string like `tag_values(table, column)`. Intentionally not a
// DataQuery: a variable query has no refId.
export interface KwdbVariableQuery {
  queryType: 'tagValues' | 'tables' | 'columns';
  table?: string;
  column?: string;
}
