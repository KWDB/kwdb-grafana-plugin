import type { AdHocVariableFilter, MetricFindValue } from '@grafana/data';

import type { KwdbQuery } from './types';

/** Quotes a SQL identifier, doubling any embedded double quote. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Quotes a SQL string literal, doubling any embedded single quote. */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Ad Hoc operators this data source can express, including the two regular
 * expression operators, which KWDB supports with PostgreSQL's `~` / `!~`
 * syntax.
 */
const supportedOperators = new Set(['=', '!=', '=~', '!~', '=|', '!=|', '<', '>', '<=', '>=']);

/**
 * Renders one Ad Hoc filter as a SQL condition.
 *
 * `render` is applied to every value first so a filter value may itself contain
 * a dashboard variable. The result is quoted as a literal, which is safe for
 * every supported operator: PostgreSQL coerces an unknown-typed literal to the
 * column type, so `n > '5'` works on a numeric column too, and the database
 * rejects a malformed value instead of silently matching nothing.
 *
 * Returns `undefined` when the filter cannot be applied: an empty key, no value,
 * or an operator this data source does not implement. Callers skip those
 * instead of emitting invalid SQL.
 */
export function adHocCondition(
  filter: AdHocVariableFilter,
  render: (value: string) => string = (value) => value
): string | undefined {
  const key = filter.key?.trim();
  const operator = filter.operator?.trim();
  if (!key || !operator || !supportedOperators.has(operator)) {
    return undefined;
  }

  // A legacy picker sends one value in `value`; the Scenes picker sends the
  // complete set in `values`. A value can be intentionally empty, so test only
  // for presence rather than truthiness.
  const rawValues = filter.values?.length ? filter.values : filter.value !== undefined ? [filter.value] : [];
  if (rawValues.length === 0) {
    return undefined;
  }

  const ident = quoteIdent(key);
  const literals = rawValues.map((value) => quoteLiteral(render(value)));

  switch (operator) {
    case '=':
    case '=|':
      return literals.length > 1 ? `${ident} IN (${literals.join(', ')})` : `${ident} = ${literals[0]}`;
    case '!=':
    case '!=|':
      return literals.length > 1 ? `${ident} NOT IN (${literals.join(', ')})` : `${ident} != ${literals[0]}`;
    case '=~':
      return `${ident} ~ ${literals[0]}`;
    case '!~':
      return `${ident} !~ ${literals[0]}`;
    default:
      // The comparison operators are the only ones left, and the operator has
      // already been checked against the supported set.
      return `${ident} ${operator} ${literals[0]}`;
  }
}

/**
 * Removes trailing whitespace, comments and statement terminators.
 *
 * A SELECT is wrapped in a CTE below, and a terminating semicolon inside the
 * parentheses would be a syntax error. Comments after that semicolon are also
 * not part of the statement and are removed together with it.
 */
export function stripStatementTerminator(sql: string): string {
  let statement = sql.trimEnd();
  for (;;) {
    if (statement.endsWith(';')) {
      statement = statement.slice(0, -1).trimEnd();
      continue;
    }
    if (statement.endsWith('*/')) {
      const start = statement.lastIndexOf('/*');
      if (start >= 0) {
        statement = statement.slice(0, start).trimEnd();
        continue;
      }
    }
    const line = /(?:^|\n)\s*--[^\n]*$/.exec(statement);
    if (line) {
      statement = statement.slice(0, line.index).trimEnd();
      continue;
    }
    return statement;
  }
}

/**
 * Reports whether a statement can be filtered by wrapping it in a CTE.
 *
 * SHOW and EXPLAIN are valid read-only statements but are not subquery-able, so
 * Ad Hoc filters cannot be applied to them.
 */
export function isFilterableStatement(sql: string): boolean {
  // The backend accepts statements that start with a comment, so a leading
  // `-- note` or `/* hint */` must not make an otherwise filterable SELECT look
  // unfilterable: that would silently run the query without the filters.
  const match = /^\s*(?:\(*)\s*([A-Za-z_]+)/.exec(stripLeadingComments(sql));
  if (!match) {
    return false;
  }
  const keyword = match[1].toUpperCase();
  return keyword === 'SELECT' || keyword === 'WITH';
}

/**
 * Removes leading whitespace and comments from a statement so the first
 * keyword becomes visible. Mirrors the backend's own guard-rail handling.
 */
export function stripLeadingComments(sql: string): string {
  let rest = sql.replace(/^\s+/, '');
  for (;;) {
    if (rest.startsWith('--')) {
      const end = rest.search(/[\r\n]/);
      rest = end < 0 ? '' : rest.slice(end + 1).replace(/^\s+/, '');
      continue;
    }
    if (rest.startsWith('/*')) {
      let depth = 1;
      let i = 2;
      while (i < rest.length && depth > 0) {
        if (rest[i] === '/' && rest[i + 1] === '*') {
          depth++;
          i += 2;
          continue;
        }
        if (rest[i] === '*' && rest[i + 1] === '/') {
          depth--;
          i += 2;
          continue;
        }
        i++;
      }
      rest = rest.slice(Math.min(i, rest.length)).replace(/^\s+/, '');
      continue;
    }
    return rest;
  }
}

/**
 * Applies Ad Hoc filter conditions to a statement.
 *
 * The statement is wrapped rather than rewritten in place because locating the
 * correct source of arbitrary SQL (joins, CTEs and nested queries) requires a
 * parser. A Raw SQL statement is therefore required to project every filtered
 * column; builder queries use the structured filter injection in `buildSql`
 * instead and do not rely on this fallback.
 *
 * Conditions are ignored for statements that cannot be wrapped, and when there
 * are none the statement is returned unchanged.
 */
export function applyAdHocFilters(sql: string, conditions: string[]): string {
  if (conditions.length === 0) {
    return sql;
  }

  const statement = stripStatementTerminator(sql);
  if (!isFilterableStatement(statement)) {
    return sql;
  }

  const filtered = ['SELECT *', 'FROM (', statement, ') AS adhoc_filters', `WHERE ${conditions.join(' AND ')}`].join(
    '\n'
  );
  // Already wrapped (Grafana interpolates a target more than once on the
  // Explore and alert-rule paths): replace the previous conditions instead of
  // nesting another wrapper.
  return isAdHocWrapped(sql) ? replaceAdHocWrapper(sql, conditions) : filtered;
}

/**
 * Reports whether a statement is the wrapper produced by `applyAdHocFilters`.
 *
 * Idempotency matters: Grafana calls `applyTemplateVariables` again when an
 * already-interpolated panel target is opened in Explore or used by an alert
 * rule. A second wrap would nest `FROM (…) AS adhoc_filters` and change the
 * executed SQL without any visible error.
 */
export function isAdHocWrapped(sql: string): boolean {
  const match = /^\s*SELECT \*\nFROM \(\n([\s\S]*)\n\) AS adhoc_filters\nWHERE [\s\S]*$/.exec(sql);
  return match !== null;
}

/**
 * Replaces the conditions of an existing wrapper, keeping its inner statement.
 * Returns the input unchanged when the outer shape cannot be recognised.
 */
export function replaceAdHocWrapper(sql: string, conditions: string[]): string {
  const match = /^\s*SELECT \*\nFROM \(\n([\s\S]*)\n\) AS adhoc_filters\nWHERE [\s\S]*$/.exec(sql);
  if (!match) {
    return sql;
  }
  return ['SELECT *', 'FROM (', match[1], ') AS adhoc_filters', `WHERE ${conditions.join(' AND ')}`].join('\n');
}

/**
 * Appends conditions to the source WHERE clause of a builder-generated query.
 *
 * Only `buildSql` output is passed here, and `applyTemplateVariables` always
 * regenerates that statement from the structured fields, so this never sees an
 * already-filtered statement and needs no idempotency handling.
 */
export function addConditionsToBuilderSql(sql: string, conditions: string[]): string {
  if (!sql || conditions.length === 0) {
    return sql;
  }
  const marker = '\nWHERE ';
  const where = sql.indexOf(marker);
  if (where < 0) {
    return sql;
  }
  const start = where + marker.length;
  return `${sql.slice(0, where)}${marker}${conditions.join(' AND ')} AND ${sql.slice(start)}`;
}

/**
 * Returns the distinct tables an Ad Hoc picker should inspect.
 *
 * Grafana's legacy dashboard picker calls `getTagKeys`/`getTagValues` without
 * panel targets. The query editor therefore persists an explicit Ad Hoc table;
 * builder queries fall back to their normal table. Raw SQL with neither set has
 * no unambiguous table, so it contributes no metadata lookup.
 */
export function adHocTables(queries: KwdbQuery[] | undefined): string[] {
  const tables = new Set<string>();
  for (const query of queries ?? []) {
    const table = query.adHocTable?.trim() || query.table?.trim();
    if (table) {
      tables.add(table);
    }
  }
  return Array.from(tables);
}

/** Converts resource string results to Grafana's MetricFindValue shape. */
export function uniqueMetricFindValues(values: string[]): MetricFindValue[] {
  return Array.from(new Set(values)).map((value) => ({ text: value, value }));
}
