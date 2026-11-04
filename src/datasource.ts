import {
  AdHocVariableFilter,
  CoreApp,
  DataSourceGetTagKeysOptions,
  DataSourceGetTagValuesOptions,
  DataSourceInstanceSettings,
  MetricFindValue,
  ScopedVars,
} from '@grafana/data';
import { DataSourceWithBackend, getTemplateSrv, TemplateSrv } from '@grafana/runtime';

import { adHocCondition, adHocFilterSupport, adHocTables, uniqueMetricFindValues } from './adHocFilters';
import { buildSql } from './sqlBuilder';
import { interpolateSql } from './sqlInterpolation';
import { ColumnInfo, DEFAULT_QUERY, KwdbAdHocFilter, KwdbDataSourceOptions, KwdbQuery, TableInfo } from './types';
import { parseVariableQuery } from './variableQuery';
import { KwdbVariableSupport } from './variableSupport';

export class KwdbDataSource extends DataSourceWithBackend<KwdbQuery, KwdbDataSourceOptions> {
  constructor(
    instanceSettings: DataSourceInstanceSettings<KwdbDataSourceOptions>,
    // Injectable for tests: Grafana sets the singleton before a data source is
    // constructed, but a unit test has no template service to install.
    private readonly templateSrv: TemplateSrv = getTemplateSrv()
  ) {
    super(instanceSettings);
    this.variables = new KwdbVariableSupport(this);
  }

  getTables(): Promise<TableInfo[]> {
    return this.getResource('/tables');
  }

  getColumns(table: string): Promise<ColumnInfo[]> {
    return this.getResource(`/columns?table=${encodeURIComponent(table)}`);
  }

  // Named fetchTagValues to avoid clashing with the DataSourceApi.getTagValues(options) API.
  fetchTagValues(table: string, column: string): Promise<string[]> {
    return this.getResource(`/tag-values?table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}`);
  }

  fetchTagKeys(table: string): Promise<string[]> {
    return this.getResource(`/tag-keys?table=${encodeURIComponent(table)}`);
  }

  /**
   * Remembers the table supplied by query-aware metadata callers. Grafana's
   * legacy dashboard picker calls getTagKeys/getTagValues without panel targets,
   * so it cannot provide the current query. Keeping the last explicit table
   * lets that picker still offer useful candidates without guessing from Raw
   * SQL joins and subqueries.
   */
  private lastAdHocTable?: string;

  private metadataTables(queries: KwdbQuery[] | undefined): string[] {
    const tables = adHocTables(queries);
    if (tables.length > 0) {
      this.lastAdHocTable = tables[0];
      return tables;
    }
    // `queries: []` means "no target information" just as an absent field does.
    return this.lastAdHocTable ? [this.lastAdHocTable] : [];
  }

  /** Candidate keys for a dashboard Ad Hoc filter. */
  async getTagKeys(options?: DataSourceGetTagKeysOptions<KwdbQuery>): Promise<MetricFindValue[]> {
    const tables = this.metadataTables(options?.queries);
    if (tables.length === 0) {
      return [];
    }
    // One unreadable table (dropped, renamed, or in another database) must not
    // break the picker for the tables that are still valid.
    const results = await Promise.allSettled(tables.map((table) => this.fetchTagKeys(table)));
    return uniqueMetricFindValues(results.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
  }

  /** Candidate values for an Ad Hoc filter key on the selected table. */
  async getTagValues(options: DataSourceGetTagValuesOptions<KwdbQuery>): Promise<MetricFindValue[]> {
    // Only tables that declare this key are queried: asking a table without the
    // column makes the backend reject the request as a non-tag column.
    const tables = options.queries?.length
      ? adHocTables(options.queries)
      : this.lastAdHocTable
        ? [this.lastAdHocTable]
        : [];
    if (tables.length === 0) {
      return [];
    }

    const perTable = await Promise.allSettled(
      tables.map(async (table) => {
        const keys = await this.fetchTagKeys(table);
        return keys.includes(options.key) ? this.fetchTagValues(table, options.key) : [];
      })
    );
    return uniqueMetricFindValues(perTable.flatMap((result) => (result.status === 'fulfilled' ? result.value : [])));
  }

  getDefaultQuery(_: CoreApp): Partial<KwdbQuery> {
    return { ...DEFAULT_QUERY };
  }

  /**
   * Expands dashboard variables and applies Ad Hoc filters to the SQL that is
   * sent to KWDB.
   *
   * `DataSourceWithBackend` does not interpolate anything by default, so
   * without this override `${interval}` or `$station` reached the database
   * verbatim and Ad Hoc filters were dropped entirely.
   *
   * Query Builder targets are regenerated from their structured fields and
   * then interpolated, so variables inside free-text fields (the interval, the
   * EVENT/STATE conditions) are expanded, and Ad Hoc predicates can be added to
   * the source `WHERE` before aggregation. Raw SQL targets are interpolated in
   * place and filtered by the wrapper documented in `adHocFilters.ts`. The
   * saved query is never mutated: the editor keeps showing what the user wrote.
   *
   * Grafana time macros (`$__timeFilter`, `$__timeFrom`, `$__timeTo`,
   * `$__timeGroup`) are left in place for the backend to expand, because they
   * need the query time range and must be rendered with full precision.
   */
  applyTemplateVariables(query: KwdbQuery, scopedVars: ScopedVars, filters?: AdHocVariableFilter[]): KwdbQuery {
    const sql = query.rawSql ?? '';
    const table = query.adHocTable?.trim() || query.table?.trim();
    if (table) {
      this.lastAdHocTable = table;
    }

    const isBuilder = query.mode !== 'raw';
    if (isBuilder && !query.table) {
      // An incomplete builder target has nothing to regenerate; fall back to
      // whatever statement was persisted so variables are still expanded.
      if (sql.trim() === '') {
        return query;
      }
    } else if (!isBuilder && sql.trim() === '') {
      return query;
    }

    // Builder statements are rebuilt from the structured fields because Ad Hoc
    // predicates must land in the source WHERE clause, before aggregation and
    // row limits. The rebuild happens before interpolation: builder fields such
    // as the interval and EVENT/STATE conditions are free text and may contain
    // dashboard variables too.
    const source = isBuilder && query.table ? buildSql(query) : sql;
    if (source.trim() === '') {
      return query;
    }

    let interpolated = interpolateSql(source, scopedVars, (target, vars, format) =>
      this.templateSrv.replace(target, vars, format)
    );

    // Grafana passes one Ad Hoc filter list per request, so the same list
    // reaches every target. Rather than injecting all of it here — which made a
    // dashboard mixing tables fail on targets whose table lacks the column —
    // the rendered predicates are attached to this target and the backend keeps
    // only the ones its table actually declares (issue #80).
    const rendered = renderAdHocFilters(filters, scopedVars, this.templateSrv);

    // A target marked exempt cannot carry a filter at all (joins, set
    // operations, relational tables without tag columns). It is left untouched
    // rather than erroring on every dashboard that has an active filter.
    if (query.adHocExempt) {
      if (interpolated === sql) {
        return query;
      }
      return { ...query, rawSql: interpolated, adHocFilters: undefined };
    }

    // Raw SQL is still checked here: a statement the backend cannot safely
    // rewrite has to be reported, and only the frontend knows the shape it
    // produced.
    if (!isBuilder || !query.table) {
      if (rendered.length > 0) {
        const support = adHocFilterSupport(
          interpolated,
          rendered.map((filter) => filter.condition)
        );
        if (!support.supported) {
          // An exception thrown during interpolation only reaches the browser
          // console and leaves the panel empty, so the reason is carried on the
          // query for the backend to report as a normal query error.
          if (interpolated === sql) {
            return { ...query, adHocError: adHocUnsupportedMessage(support.reason) };
          }
          return { ...query, rawSql: interpolated, adHocError: adHocUnsupportedMessage(support.reason) };
        }
      }
    }

    if (interpolated === sql && rendered.length === 0) {
      return query;
    }
    return {
      ...query,
      rawSql: interpolated,
      // Carried to the backend, which decides per table whether each filter
      // applies. The SQL itself is left unfiltered here.
      adHocFilters: rendered.length > 0 ? rendered : undefined,
    };
  }

  // Used by Grafana to decide whether a query still needs interpolation (for
  // example in alerting, where an unexpanded query must not be evaluated).
  targetContainsTemplate(query: KwdbQuery): boolean {
    if (!query.rawSql) {
      return false;
    }
    // Backend macros are not dashboard variables. The SQL datasources shipped
    // with Grafana strip them before asking TemplateSrv for the same reason.
    const withoutMacros = query.rawSql
      .replace(/\$__timeFilter\s*\(/g, '(')
      .replace(/\$__timeGroup\s*\(/g, '(')
      .replace(/\$__timeFrom/g, '')
      .replace(/\$__timeTo/g, '');
    return this.templateSrv.containsTemplate(withoutMacros);
  }

  // Supports dashboard/template variables. Accepts either a structured KwdbVariableQuery
  // (produced by VariableQueryEditor) or a raw query string such as
  // `tag_values(table, column)`, `tables()` or `columns(table)`.
  async metricFindQuery(query: any, _options?: any): Promise<MetricFindValue[]> {
    const parsed = parseVariableQuery(query);
    switch (parsed.queryType) {
      case 'tables': {
        const tables = await this.getTables();
        return (tables ?? []).map((table) => ({ text: table.name, value: table.name }));
      }
      case 'columns': {
        const columns = await this.getColumns(parsed.table ?? '');
        return (columns ?? []).map((column) => ({ text: column.name, value: column.name }));
      }
      case 'tagValues': {
        const values = await this.fetchTagValues(parsed.table ?? '', parsed.column ?? '');
        return (values ?? []).map((value) => ({ text: value, value }));
      }
      default:
        throw new Error(`Unsupported variable query type: ${JSON.stringify(parsed)}`);
    }
  }

  annotations = {};

  filterQuery(query: KwdbQuery): boolean {
    if (query.mode === 'raw') {
      return Boolean(query.rawSql?.trim());
    }
    return Boolean(query.table);
  }
}

/**
 * Renders Ad Hoc filters as SQL predicates.
 *
 * Filter values are interpolated as ordinary dashboard variables first, then
 * quoted as literals; rendering them separately keeps a quoted predicate from
 * being re-interpolated or re-escaped.
 */
/**
 * Renders Ad Hoc filters as structured predicates.
 *
 * Each entry keeps the column name next to the rendered SQL so the backend can
 * decide whether the target's table declares that column. Value variables are
 * expanded first, and a multi-valued variable becomes an `IN (...)` list.
 */
function renderAdHocFilters(
  filters: AdHocVariableFilter[] | undefined,
  scopedVars: ScopedVars,
  templateSrv: TemplateSrv
): KwdbAdHocFilter[] {
  const rendered: KwdbAdHocFilter[] = [];
  for (const filter of filters ?? []) {
    const key = filter.key?.trim();
    const operator = filter.operator?.trim();
    if (!key || !operator) {
      continue;
    }
    for (const condition of adHocConditions(filter, scopedVars, templateSrv)) {
      if (condition) {
        rendered.push({ key, operator, condition });
      }
    }
  }
  return rendered;
}

/**
 * Renders one Ad Hoc filter, expanding a dashboard variable in its value.
 *
 * A variable used as a filter value must be expanded before the literal is
 * quoted, or `station_id = $station` would reach the database literally. When
 * the variable is multi-valued the filter becomes a multi-value condition so
 * every selected value is kept instead of being flattened into one string.
 */
function adHocConditions(
  filter: AdHocVariableFilter,
  scopedVars: ScopedVars,
  templateSrv: TemplateSrv
): Array<string | undefined> {
  const expanded = expandFilterValues(filter, scopedVars, templateSrv);
  if (Array.isArray(expanded)) {
    return [adHocCondition({ ...filter, value: expanded[0], values: expanded })];
  }
  return [adHocCondition({ ...filter, value: expanded })];
}

/**
 * Substitutes dashboard variables found in a filter value.
 *
 * Returns an array when the value references a multi-value or `All` variable,
 * so the caller can build `IN (...)` instead of quoting a list as one string.
 */
function expandFilterValues(
  filter: AdHocVariableFilter,
  scopedVars: ScopedVars,
  templateSrv: TemplateSrv
): string | string[] {
  const values = filter.values?.length ? filter.values : filter.value !== undefined ? [filter.value] : [];
  const expandedValues: string[] = [];

  for (const value of values) {
    if (!templateSrv.containsTemplate(value)) {
      expandedValues.push(value);
      continue;
    }
    const replaced = templateSrv.replace(value, scopedVars);
    // A multi-value variable resolves through the glob formatter to `{a,b}`.
    if (replaced.startsWith('{') && replaced.endsWith('}')) {
      expandedValues.push(
        ...replaced
          .slice(1, -1)
          .split(',')
          .map((item) => item.trim())
      );
      continue;
    }
    expandedValues.push(replaced);
  }

  // Return a list when the filter is genuinely multi-valued, either because it
  // already carried several values or because one variable expanded to a list.
  if (expandedValues.length > 1) {
    return expandedValues;
  }
  return expandedValues[0] ?? '';
}

/**
 * Explains why a Raw SQL target cannot carry dashboard Ad Hoc filters.
 *
 * The plugin deliberately fails here rather than running the statement
 * unfiltered: a panel that silently ignores the dashboard filter looks like it
 * returned "no matching data" for the selected value even though it returned
 * everything, which is the more dangerous outcome.
 */
function adHocUnsupportedMessage(reason: string): string {
  switch (reason) {
    case 'not-a-select':
      return 'Ad Hoc filters need a SELECT or WITH query with a source table; SHOW and EXPLAIN queries cannot be filtered.';
    case 'no-source-table':
      return 'Ad Hoc filters need a query with a FROM clause so the filter can be added to its source rows.';
    case 'complex-source':
      return (
        'Ad Hoc filters cannot be applied to Raw SQL that joins tables, uses more than one source, nests its source ' +
        'in a subquery, or combines queries with UNION. Use the Query Builder, or filter in the SQL itself.'
      );
    default:
      return 'Ad Hoc filters could not be applied to this Raw SQL query.';
  }
}
