import { addConditionsToBuilderSql } from './adHocFilters';
import type { KwdbInterpolateMode, KwdbQuery, MetricSpec } from './types';

const INDENT = '       ';

/** Aggregations emitted as `fn(column)`. `none` selects the bare column. */
const AGGREGATION_FUNCTIONS = ['avg', 'sum', 'count', 'min', 'max', 'stddev'] as const;

const LATEST_FUNCTIONS = ['last', 'last_row', 'first', 'first_row'] as const;

type LatestFunction = (typeof LATEST_FUNCTIONS)[number];

function quoteIdent(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

/**
 * Splits a possibly schema-qualified name into its identifier parts.
 *
 * Double quotes are treated as identifier-quoting syntax: a dot inside quotes
 * belongs to the name, and `""` is an escaped quote. Returns `null` when the
 * quotes are unbalanced, so the caller can treat the whole input as one
 * literal identifier (that is what a name containing a quote character looks
 * like).
 */
export function splitQualifiedName(name: string): string[] | null {
  const parts: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < name.length; index += 1) {
    const char = name[index];
    if (char === '"') {
      if (inQuotes && name[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }
    if (char === '.' && !inQuotes) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (inQuotes) {
    return null;
  }

  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * Quotes a possibly schema-qualified identifier such as `db.table`.
 *
 * Dots are only treated as separators when they are outside double quotes:
 * `my.table` becomes `"my"."table"`, `"my.table"` stays a single quoted
 * identifier named `my.table`, and `db."my.table"` keeps both parts. An
 * unbalanced quote makes the whole input a single literal name, so a quote
 * character in a table name is escaped (`sen"sors` -> `"sen""sors"`).
 */
export function quoteQualified(name: string): string {
  const trimmed = name.trim();
  const parts = splitQualifiedName(trimmed);
  if (!parts || parts.length === 0) {
    return quoteIdent(trimmed);
  }
  return parts.map(quoteIdent).join('.');
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const INTERPOLATE_MODES: readonly KwdbInterpolateMode[] = ['linear', 'prev', 'next', 'null', 'constant'];

/**
 * Normalizes the interpolation mode, including uppercase values such as
 * `PREV` / `NEXT` / `NULL` that older dashboards may still contain.
 */
export function normalizeInterpolateMode(mode?: string): KwdbInterpolateMode {
  const normalized = mode?.trim().toLowerCase();
  return INTERPOLATE_MODES.find((item) => item === normalized) ?? 'linear';
}

function normalizeInterpolateConstant(value?: number): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function interpolateModeLiteral(query: KwdbQuery): string {
  const mode = normalizeInterpolateMode(query.interpolateMode);
  if (mode === 'constant') {
    // KWDB's interpolate() takes a constant value, not a 'constant' keyword:
    // interpolate(expr, 'constant') fails with "Interpolate/imputation method
    // not supported". The value is emitted as a quoted numeric string, matching
    // the form in the KWDB documentation (interpolate(avg(temperature), '25')).
    return quoteString(String(normalizeInterpolateConstant(query.interpolateConstant)));
  }
  return quoteString(mode);
}

function isSupportedAggregation(value: unknown): value is MetricSpec['aggregation'] {
  return value === 'none' || (AGGREGATION_FUNCTIONS as readonly string[]).includes(value as string);
}

/**
 * A dashboard JSON file is not type-checked, so an aggregation outside the
 * supported union has to be rejected instead of being spliced into the
 * statement verbatim.
 */
function metricsUseSupportedAggregations(metrics: MetricSpec[]): boolean {
  return metrics.every((metric) => isSupportedAggregation(metric.aggregation));
}

function normalizeLatestFunc(value: unknown): LatestFunction | null {
  return (LATEST_FUNCTIONS as readonly string[]).includes(value as string) ? (value as LatestFunction) : null;
}

function aggregationExpr(metric: MetricSpec): string {
  const column = metric.column?.trim() ?? '';
  if (metric.aggregation === 'none') {
    return quoteIdent(column);
  }
  return `${metric.aggregation}(${quoteIdent(column)})`;
}

/**
 * Builds the implicit alias for a metric. Only reached without an explicit
 * alias, and never with aggregation `none`: both call sites return the bare
 * expression early in that case (gapfill coerces `none` to `avg` first).
 */
function metricAlias(metric: MetricSpec, prefix: string): string {
  return `${prefix}_${metric.column?.trim() ?? ''}`;
}

function metricExpr(metric: MetricSpec): string {
  const expr = aggregationExpr(metric);
  const alias = metric.alias?.trim();
  if (metric.aggregation === 'none' && !alias) {
    return expr;
  }
  return `${expr} AS ${quoteIdent(alias || metricAlias(metric, metric.aggregation))}`;
}

/**
 * Gapfill cannot take a bare column: `interpolate()` requires an aggregate
 * function as its first argument ("the first parameter of interpolate must be
 * agg func"). Queries saved while `none` was still offered for gapfill are
 * corrected to `avg` instead of emitting a statement KWDB rejects.
 */
export function coerceGapfillMetric(metric: MetricSpec): MetricSpec {
  return metric.aggregation === 'none' ? { ...metric, aggregation: 'avg' } : metric;
}

function gapfillMetricExpr(metric: MetricSpec, query: KwdbQuery): string {
  const expr = `interpolate(${aggregationExpr(metric)}, ${interpolateModeLiteral(query)})`;
  return `${expr} AS ${quoteIdent(metric.alias?.trim() || metricAlias(metric, metric.aggregation))}`;
}

function latestMetricExpr(metric: MetricSpec, latestFunc: LatestFunction): string {
  const column = quoteIdent(metric.column?.trim() ?? '');
  return `${latestFunc}(${column}) AS ${quoteIdent(metric.alias?.trim() || `latest_${metric.column?.trim() ?? ''}`)}`;
}

function latestTimeExpr(latestFunc: LatestFunction, timeColumn: string): string {
  // `*_row` variants include NULL rows for the value, but the time column
  // cannot be NULL in a time-series table, so plain first()/last() is used.
  const func = latestFunc === 'first' || latestFunc === 'first_row' ? 'first' : 'last';
  return `${func}(${quoteIdent(timeColumn)}) AS "time"`;
}

function timeExpr(functionName: 'time_bucket' | 'time_bucket_gapfill', query: KwdbQuery, timeColumn: string): string {
  // A blank interval is treated as "not set" rather than being passed through:
  // `time_bucket(ts, '   ')` is a hard SQL error, not a usable default.
  const interval = query.interval?.trim() || '5m';
  return `${functionName}(${quoteIdent(timeColumn)}, ${quoteString(interval)})`;
}

function selectLines(items: string[]): string[] {
  return items.map((item, index) => {
    const comma = index < items.length - 1 ? ',' : '';
    return index === 0 ? `SELECT ${item}${comma}` : `${INDENT}${item}${comma}`;
  });
}

function groupAndOrderBy(tags: string[], rawColumns: string[]): { groupBy: string[]; orderBy: string[] } {
  const quotedTags = tags.map(quoteIdent);
  return {
    groupBy: ['"time"', ...quotedTags, ...rawColumns],
    orderBy: ['"time"', ...quotedTags, ...rawColumns],
  };
}

function validMetrics(query: KwdbQuery): MetricSpec[] {
  return (query.metrics ?? []).filter((metric) => Boolean(metric.column?.trim()));
}

/**
 * Metric columns selected without an aggregation.
 *
 * KWDB rejects a bare column in a grouped SELECT ("column ... must appear in
 * the GROUP BY clause or be used in an aggregate function"), so these columns
 * have to be added to the GROUP BY list instead of being dropped. Verified
 * against KWDB 3.3.0: `GROUP BY "time", "current_val"` is accepted by
 * time_bucket and every window function. Gapfill never reaches this with
 * `none`, because `none` is coerced to `avg` there.
 */
function unaggregatedColumns(metrics: MetricSpec[]): string[] {
  const columns: string[] = [];
  for (const metric of metrics) {
    const column = metric.column?.trim() ?? '';
    if (metric.aggregation === 'none' && column) {
      const quoted = quoteIdent(column);
      if (!columns.includes(quoted)) {
        columns.push(quoted);
      }
    }
  }
  return columns;
}

export function buildDownsamplingSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  if (!table || !timeColumn || metrics.length === 0 || !metricsUseSupportedAggregations(metrics)) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [
    `${timeExpr('time_bucket', query, timeColumn)} AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map(metricExpr),
  ];
  const raw = unaggregatedColumns(metrics);
  const { groupBy, orderBy } = groupAndOrderBy(tags, raw);
  return [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${orderBy.join(', ')}`,
  ].join('\n');
}

export function buildGapfillSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query).map(coerceGapfillMetric);
  if (!table || !timeColumn || metrics.length === 0 || !metricsUseSupportedAggregations(metrics)) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [
    `${timeExpr('time_bucket_gapfill', query, timeColumn)} AS "time"`,
    ...tags.map(quoteIdent),
    ...metrics.map((metric) => gapfillMetricExpr(metric, query)),
  ];
  const raw = unaggregatedColumns(metrics);
  const { groupBy, orderBy } = groupAndOrderBy(tags, raw);
  return [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${orderBy.join(', ')}`,
  ].join('\n');
}

export function buildLatestSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  const latestFunc = normalizeLatestFunc(query.latestFunc ?? 'last');
  if (!table || !timeColumn || metrics.length === 0 || !latestFunc || !metricsUseSupportedAggregations(metrics)) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [
    ...tags.map(quoteIdent),
    ...metrics.map((metric) => latestMetricExpr(metric, latestFunc)),
    latestTimeExpr(latestFunc, timeColumn),
  ];
  const lines = [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
  ];
  if (tags.length > 0) {
    lines.push(`GROUP BY ${tags.map(quoteIdent).join(', ')}`);
  }
  return lines.join('\n');
}

// Free-form SQL fragments (event and state conditions) are spliced into the
// statement verbatim, so anything that could terminate the statement or open a
// comment is rejected here. The backend read-only guard is the last line of
// defence; this keeps the editor from producing a statement that only fails
// deep inside the database.
const UNSAFE_SQL_FRAGMENT_RE = /;|--|\/\*|\*\//;

function isSafeSqlFragment(fragment: string): boolean {
  return !UNSAFE_SQL_FRAGMENT_RE.test(fragment);
}

/**
 * COUNT_WINDOW arguments are positive integers: KWDB declares them as `int8`
 * row counts, so `10.5` or `0` fails inside the database.
 */
function positiveIntArgument(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    return null;
  }
  return String(numeric);
}

function windowTimeExpr(query: KwdbQuery): string | null {
  const timeColumn = query.timeColumn?.trim();
  switch (query.windowType) {
    case 'TIME_WINDOW':
    case 'SESSION_WINDOW': {
      if (!timeColumn) {
        return null;
      }
      const interval = quoteString(
        query.windowInterval?.trim() || (query.windowType === 'SESSION_WINDOW' ? '5m' : '1h')
      );
      const slide = query.windowSlide?.trim();
      if (query.windowType === 'TIME_WINDOW' && slide) {
        return `TIME_WINDOW(${quoteIdent(timeColumn)}, ${interval}, ${quoteString(slide)})`;
      }
      return `${query.windowType}(${quoteIdent(timeColumn)}, ${interval})`;
    }
    case 'EVENT_WINDOW': {
      const start = query.eventStartCond?.trim();
      const end = query.eventEndCond?.trim();
      if (!start || !end || !isSafeSqlFragment(start) || !isSafeSqlFragment(end)) {
        return null;
      }
      return `EVENT_WINDOW(${start}, ${end})`;
    }
    case 'COUNT_WINDOW': {
      // Defaults to 100 because that is the initial value the editor shows in
      // the "Row limit" field. Without the default the two disagree: the field
      // reads 100 while the generated statement is empty, and setting the field
      // to the value it already displays is a no-op for a React controlled
      // input, so the user cannot make the preview appear by typing it in.
      const limit = positiveIntArgument(query.windowInterval?.trim() || '100');
      if (!limit) {
        return null;
      }
      const slideRaw = query.windowSlide?.trim();
      if (!slideRaw) {
        return `COUNT_WINDOW(${limit})`;
      }
      const slide = positiveIntArgument(slideRaw);
      return slide ? `COUNT_WINDOW(${limit}, ${slide})` : null;
    }
    case 'STATE_WINDOW': {
      const expr = query.eventStartCond?.trim();
      if (!expr || !isSafeSqlFragment(expr)) {
        return null;
      }
      return `STATE_WINDOW(${expr})`;
    }
    default:
      return null;
  }
}

export function buildWindowSql(query: KwdbQuery): string {
  const table = query.table?.trim();
  const timeColumn = query.timeColumn?.trim();
  const metrics = validMetrics(query);
  const windowExpr = windowTimeExpr(query);
  if (!table || !timeColumn || metrics.length === 0 || !windowExpr || !metricsUseSupportedAggregations(metrics)) {
    return '';
  }

  const tags = (query.tags ?? []).map((tag) => tag.trim()).filter(Boolean);
  const items = [`first(${quoteIdent(timeColumn)}) AS "time"`, ...tags.map(quoteIdent), ...metrics.map(metricExpr)];
  // KWDB requires a grouped window function to be the *last* GROUP BY entry:
  // "no other columns can follow grouped window function". Non-aggregated
  // metric columns therefore go before the window expression.
  const groupBy = [...tags.map(quoteIdent), ...unaggregatedColumns(metrics), windowExpr];
  const orderBy = ['"time"', ...tags.map(quoteIdent)];
  return [
    ...selectLines(items),
    `FROM ${quoteQualified(table)}`,
    `WHERE ${quoteIdent(timeColumn)} >= $__timeFrom AND ${quoteIdent(timeColumn)} <= $__timeTo`,
    `GROUP BY ${groupBy.join(', ')}`,
    `ORDER BY ${orderBy.join(', ')}`,
  ].join('\n');
}

export function buildRawSql(query: KwdbQuery): string {
  return query.rawSql ?? '';
}

/**
 * Builds the statement for one query. `filterConditions` are already-rendered
 * Ad Hoc predicates; builder modes inject them into the source WHERE clause
 * before aggregation, while Raw SQL uses its explicit custom statement and is
 * filtered by the datasource's Raw SQL wrapper instead.
 */
export function buildSql(query: KwdbQuery, filterConditions: string[] = []): string {
  switch (query.mode) {
    case 'gapfill':
      return addConditionsToBuilderSql(buildGapfillSql(query), filterConditions);
    case 'latest':
      return addConditionsToBuilderSql(buildLatestSql(query), filterConditions);
    case 'window':
      return addConditionsToBuilderSql(buildWindowSql(query), filterConditions);
    case 'raw':
      return buildRawSql(query);
    case 'downsampling':
    default:
      return addConditionsToBuilderSql(buildDownsamplingSql(query), filterConditions);
  }
}
