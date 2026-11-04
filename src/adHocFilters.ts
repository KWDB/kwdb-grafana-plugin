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
      // Multiple patterns are ORed so every selected value keeps its meaning.
      // Using only the first pattern would silently narrow the filter.
      return literals.length > 1
        ? `(${literals.map((literal) => `${ident} ~ ${literal}`).join(' OR ')})`
        : `${ident} ~ ${literals[0]}`;
    case '!~':
      // "not matching any of" is an AND over the negations: a row is kept only
      // when it matches none of the patterns.
      return literals.length > 1
        ? `(${literals.map((literal) => `${ident} !~ ${literal}`).join(' AND ')})`
        : `${ident} !~ ${literals[0]}`;
    default: {
      // Comparison operators are single-valued by nature: `x > '5' AND x > '9'`
      // is just `x > '9'`, and picking one silently would be worse. Rejecting
      // the multi-value form keeps the behaviour explicit.
      if (literals.length > 1) {
        return undefined;
      }
      // The operator has already been checked against the supported set.
      return `${ident} ${operator} ${literals[0]}`;
    }
  }
}

/**
 * Removes trailing whitespace, comments and statement terminators.
 *
 * A SELECT is wrapped in a derived table below, and a terminating semicolon
 * inside the parentheses would be a syntax error. Comments after that semicolon
 * are not part of the statement either, so they are removed with it. The scan
 * is token-aware rather than regex-based: a semicolon followed by a trailing
 * line or block comment, and a comment marker that only appears inside a
 * string literal, all have to be told apart correctly. A `--` inside a literal
 * is not a comment at all.
 */
export function stripStatementTerminator(sql: string): string {
  let statement = sql.trimEnd();
  for (;;) {
    const trimmed = stripOneTrailingTrivia(statement);
    if (trimmed === statement) {
      return statement;
    }
    statement = trimmed;
  }
}

/** Drops one trailing run of trivia: whitespace, a comment, or a semicolon. */
function stripOneTrailingTrivia(sql: string): string {
  const trimmed = sql.trimEnd();
  if (trimmed === '') {
    return '';
  }

  if (trimmed.endsWith(';')) {
    return trimmed.slice(0, -1).trimEnd();
  }

  // Only a comment that actually ends the statement is removed; `--` and `/*`
  // inside a string, a quoted identifier, a dollar-quoted body or another
  // comment do not qualify.
  const trailing = findTrailingComment(trimmed);
  if (trailing !== null) {
    return trimmed.slice(0, trailing).trimEnd();
  }

  return trimmed;
}

/**
 * Returns the offset where a comment that runs to the end of `sql` starts, or
 * null when the statement does not end with a comment.
 *
 * This walks the statement once with the same lexical rules the interpolation
 * scanner uses, so quotes and dollar-quoting cannot be mistaken for comments.
 */
function findTrailingComment(sql: string): number | null {
  let lastCommentStart: number | null = null;

  for (let i = 0; i < sql.length;) {
    const char = sql[i];

    if (char === '-' && sql[i + 1] === '-') {
      const newline = sql.slice(i).search(/[\r\n]/);
      lastCommentStart = i;
      if (newline < 0) {
        return i;
      }
      i += newline;
      continue;
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = skipBlockComment(sql, i);
      // A block comment is trailing only when nothing but whitespace follows it.
      if (end >= sql.length) {
        return i;
      }
      if (sql.slice(end).trim() === '') {
        return i;
      }
      lastCommentStart = null;
      i = end;
      continue;
    }

    if (char === "'") {
      i = skipQuoted(sql, i, "'");
      lastCommentStart = null;
      continue;
    }

    if (char === '"') {
      i = skipQuoted(sql, i, '"');
      lastCommentStart = null;
      continue;
    }

    if (char === '$') {
      const end = skipDollarQuoted(sql, i);
      if (end > i) {
        i = end;
        lastCommentStart = null;
        continue;
      }
    }

    if (!/\s/.test(char)) {
      lastCommentStart = null;
    }
    i++;
  }

  return lastCommentStart;
}

/** Returns the offset just past a block comment, honouring nesting. */
function skipBlockComment(sql: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < sql.length;) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth++;
      i += 2;
      continue;
    }
    if (sql[i] === '*' && sql[i + 1] === '/') {
      depth--;
      i += 2;
      if (depth === 0) {
        return i;
      }
      continue;
    }
    i++;
  }
  return sql.length;
}

/** Returns the offset just past a quoted run, doubling-aware. */
function skipQuoted(sql: string, start: number, quote: string): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== quote) {
      continue;
    }
    if (sql[i + 1] === quote) {
      i++;
      continue;
    }
    return i + 1;
  }
  return sql.length;
}

/** Returns the offset just past a dollar-quoted body, or `start` when none starts here. */
function skipDollarQuoted(sql: string, start: number): number {
  const previous = start > 0 ? sql[start - 1] : '';
  if (previous && /[A-Za-z0-9_$]/.test(previous)) {
    return start;
  }

  let i = start + 1;
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) {
    i++;
  }
  if (sql[i] !== '$') {
    return start;
  }
  if (i > start + 1 && /[0-9]/.test(sql[start + 1])) {
    return start;
  }

  const tag = sql.slice(start, i + 1);
  const close = sql.indexOf(tag, i + 1);
  return close < 0 ? start : close + tag.length;
}

/**
 * Reports whether a statement can be filtered at all.
 *
 * SHOW and EXPLAIN are valid read-only statements but have no source `WHERE`
 * to add conditions to, so Ad Hoc filters cannot be applied to them.
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
 * Applies Ad Hoc filter conditions to a Raw SQL statement.
 *
 * Conditions must filter source rows, not the finished result: a Raw SQL
 * statement commonly aggregates or limits, and wrapping it would filter after
 * that, returning different rows than the same filter on a Query Builder
 * target. For a statement with a single top-level `FROM <table>` the predicate
 * is therefore appended to the source `WHERE` clause, reusing the builder
 * injection point.
 *
 * Only that simple, unambiguous shape is rewritten. A join, a subquery in
 * `FROM`, a set operation or a statement without a source table cannot be
 * filtered safely without a full parser, so the caller is expected to surface
 * `adHocFilterSupport` instead of silently running the unfiltered statement.
 */
export function applyAdHocFilters(sql: string, conditions: string[]): string {
  if (conditions.length === 0) {
    return sql;
  }

  const statement = stripStatementTerminator(sql);
  if (!isFilterableStatement(statement)) {
    return sql;
  }

  // Already rewritten (Grafana interpolates a target more than once on the
  // Explore and alert-rule paths): replace the previous conditions instead of
  // adding them again.
  if (isAdHocFiltered(statement)) {
    return replaceAdHocConditions(statement, conditions);
  }

  const injection = findSourceWhere(statement);
  if (injection === null) {
    return sql;
  }

  return injectConditions(statement, injection, conditions);
}

/** Marker appended to every injected predicate so a second pass can replace it. */
const INJECTED_MARK = '/* kwdb_adhoc */';

/** Reports whether `sql` is a statement this module already filtered. */
export function isAdHocFiltered(sql: string): boolean {
  return sql.includes(INJECTED_MARK);
}

/** Replaces the predicates previously appended by `applyAdHocFilters`. */
function replaceAdHocConditions(sql: string, conditions: string[]): string {
  const marker = sql.indexOf(INJECTED_MARK);
  if (marker < 0) {
    return sql;
  }
  // The injected text is `<mark> <cond> AND <cond> AND <original where>`. Drop
  // everything from the marker up to the clause that originally followed it.
  const before = sql.slice(0, marker);
  const rest = sql.slice(marker + INJECTED_MARK.length);
  const nextClause = /\b(GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|OFFSET|WINDOW|\))/i.exec(rest);
  const tail = nextClause ? rest.slice(nextClause.index) : '';
  return `${before}${INJECTED_MARK} ${conditions.join(' AND ')}${tail === '' ? '' : `\n${tail}`}`;
}

/**
 * Where to add conditions to a statement's source `WHERE` clause.
 *
 * `render` is the text to insert. Returns null when the statement has no single
 * top-level source table, which is the only shape this module rewrites.
 */
interface SourceWhere {
  /** Offset just past the existing `WHERE` keyword, or where one must be added. */
  offset: number;
  /** True when the statement already has a WHERE clause. */
  hasWhere: boolean;
}

/**
 * Locates the top-level `WHERE` of a simple single-table SELECT.
 *
 * Returns null for anything this module cannot rewrite confidently: joins,
 * `FROM` subqueries, multiple sources (comma lists), set operations, CTEs and
 * statements without a `FROM`. Callers treat null as "cannot filter here".
 */
export function findSourceWhere(sql: string): SourceWhere | null {
  const frame = scanTopLevel(sql);
  if (frame === null) {
    return null;
  }
  if (frame.hasSetOperator || frame.fromCount !== 1 || frame.hasJoin) {
    return null;
  }
  if (frame.whereAt !== null) {
    return { offset: frame.whereAt + 'WHERE'.length, hasWhere: true };
  }
  if (frame.fromEnd === null) {
    return null;
  }
  return { offset: frame.fromEnd, hasWhere: false };
}

interface TopLevelFrame {
  whereAt: number | null;
  fromEnd: number | null;
  fromCount: number;
  hasJoin: boolean;
  hasSetOperator: boolean;
}

/**
 * Scans the outer query level only, skipping strings, identifiers, comments,
 * dollar-quoted bodies and nested parentheses.
 */
function scanTopLevel(sql: string): TopLevelFrame | null {
  const frame: TopLevelFrame = {
    whereAt: null,
    fromEnd: null,
    fromCount: 0,
    hasJoin: false,
    hasSetOperator: false,
  };
  let depth = 0;
  let fromActive = false;
  let fromDepth = 0;

  for (let i = 0; i < sql.length;) {
    const char = sql[i];

    if (char === '-' && sql[i + 1] === '-') {
      const newline = sql.slice(i).search(/[\r\n]/);
      i = newline < 0 ? sql.length : i + newline;
      continue;
    }
    if (char === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i);
      continue;
    }
    if (char === "'") {
      i = skipQuoted(sql, i, "'");
      continue;
    }
    if (char === '"') {
      i = skipQuoted(sql, i, '"');
      continue;
    }
    if (char === '$') {
      const end = skipDollarQuoted(sql, i);
      if (end > i) {
        i = end;
        continue;
      }
    }
    if (char === '(') {
      depth++;
      i++;
      continue;
    }
    if (char === ')') {
      depth--;
      i++;
      continue;
    }
    if (depth > 0) {
      i++;
      continue;
    }

    const word = readWord(sql, i);
    if (word === null) {
      i++;
      continue;
    }
    i = word.end;

    switch (word.upper) {
      case 'FROM':
        frame.fromCount++;
        fromActive = true;
        fromDepth = depth;
        break;
      case 'JOIN':
        if (fromActive) {
          frame.hasJoin = true;
        }
        break;
      case 'WHERE':
        if (frame.whereAt === null && fromActive) {
          frame.whereAt = word.start;
        }
        fromActive = false;
        break;
      case 'UNION':
      case 'INTERSECT':
      case 'EXCEPT':
        frame.hasSetOperator = true;
        fromActive = false;
        break;
      case 'GROUP':
      case 'ORDER':
      case 'LIMIT':
      case 'HAVING':
      case 'OFFSET':
      case 'WINDOW':
        if (frame.fromEnd === null && fromActive) {
          frame.fromEnd = word.start;
        }
        fromActive = false;
        break;
      default:
        break;
    }
    void fromDepth;
  }

  if (frame.fromEnd === null && fromActive) {
    frame.fromEnd = sql.length;
  }
  return frame;
}

/** Reads an unquoted SQL word at `start`, or null when there is none. */
function readWord(sql: string, start: number): { upper: string; start: number; end: number } | null {
  if (!/[A-Za-z_]/.test(sql[start])) {
    return null;
  }
  let end = start;
  while (end < sql.length && /[A-Za-z0-9_$]/.test(sql[end])) {
    end++;
  }
  // A word that is really an identifier prefix of a quoted/qualified name is
  // harmless here: only the keywords above are acted on.
  return { upper: sql.slice(start, end).toUpperCase(), start, end };
}

/** Inserts the marked predicates at the located position of a statement. */
function injectConditions(sql: string, where: SourceWhere, conditions: string[]): string {
  const injected = `${INJECTED_MARK} ${conditions.join(' AND ')}`;
  if (where.hasWhere) {
    return `${sql.slice(0, where.offset)} ${injected} AND${sql.slice(where.offset)}`;
  }
  const before = sql.slice(0, where.offset).trimEnd();
  const after = sql.slice(where.offset).trimStart();
  return `${before}\nWHERE ${injected}${after === '' ? '' : ` ${after}`}`;
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

/**
 * Describes whether Ad Hoc filters could be applied to a Raw SQL statement.
 *
 * `filtered` and the reason are reported separately from the SQL so the caller
 * can warn the user instead of returning silently unfiltered data.
 */
export type AdHocFilterSupport =
  | { supported: true }
  | {
      supported: false;
      reason:
        'not-a-select' | 'no-source-table' | 'complex-source' | 'unsupported-operator' | 'already-filtered-elsewhere';
    };

/**
 * Classifies a statement (or a set of rendered conditions) for filter support.
 *
 * `simple` is the only shape `applyAdHocFilters` rewrites: one source table,
 * no join or set operation. Everything else must be surfaced to the user.
 */
export function adHocFilterSupport(sql: string, conditions: string[]): AdHocFilterSupport {
  if (conditions.length === 0) {
    return { supported: true };
  }
  const statement = stripStatementTerminator(sql);
  if (!isFilterableStatement(statement)) {
    return { supported: false, reason: 'not-a-select' };
  }
  if (isAdHocFiltered(statement)) {
    return { supported: true };
  }
  const frame = scanTopLevel(statement);
  if (frame === null || frame.fromCount === 0) {
    return { supported: false, reason: 'no-source-table' };
  }
  if (frame.hasSetOperator || frame.fromCount !== 1 || frame.hasJoin) {
    return { supported: false, reason: 'complex-source' };
  }
  return { supported: true };
}
