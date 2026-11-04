import type { ScopedVars, TypedVariableModel, VariableWithMultiSupport } from '@grafana/data';

/**
 * Renders one template variable value as a SQL fragment.
 *
 * Mirrors the contract of the SQL data sources shipped with Grafana, which is
 * what dashboards written for them expect:
 *
 * - a single string value is escaped but not quoted, because the user already
 *   wrote the surrounding quotes (`station_id = '$station'`);
 * - a multi-value or "All" value is rendered as one quoted literal per value
 *   (`station_id IN ($station)`), because the user cannot write the quotes
 *   themselves without breaking the list;
 * - a number is emitted as-is, so a numeric filter stays numeric.
 *
 * A custom `allValue` is a raw SQL expression configured by the user (`*`,
 * `PV-%`, `now() - 1h`). Grafana passes it here as a plain string, and this
 * formatter returns it unquoted, because quoting would turn `*` into the
 * literal `'*'` and silently match nothing. The surrounding SQL decides whether
 * that expression is valid: `col LIKE '$var'`, `col ~ '$var'` and
 * `col IN ($var)` accept it, while `col = '$var'` does not. This mirrors the
 * SQL data sources Grafana ships with and is documented in the README.
 *
 * Quoting a literal uses doubling (`it's` -> `'it''s'`), which is valid for any
 * `standard_conforming_strings` setting, instead of a backslash escape.
 */
export function formatSqlInterpolation(
  value: string | string[] | number,
  variable: VariableWithMultiSupport | TypedVariableModel
): string {
  if (typeof value === 'string') {
    // A variable with `multi`/`includeAll` is normally resolved by Grafana to
    // the option array before this formatter runs, and the array branch below
    // emits the quoted list. The string branch is then only reached when the
    // array holds a single value, or when a caller passes a scoped variable
    // (`$__interval`, repeat variables) whose value was already flattened to a
    // string; quoting it would turn `time_bucket(ts, '1h')` into
    // `time_bucket(ts, ''1h'')`, so it is escaped like any other single string.
    return value.replace(/'/g, "''");
  }

  if (typeof value === 'number') {
    // TemplateSrv.replace uses the formatter's return value as the replacement
    // string. Returning a number works only by implicit coercion, so make the
    // conversion explicit and keep the SQL fragment type-honest.
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map(quoteSqlLiteral).join(',');
  }

  return String(value);
}

/** Wraps a value in single quotes, doubling any quote inside it. */
export function quoteSqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * The subset of Grafana's `TemplateSrv.replace` this module needs. Accepting it
 * as a parameter keeps the module testable without a running Grafana instance.
 */
export type SqlInterpolator = (target: string, scopedVars: ScopedVars, format?: string | Function) => string;

/**
 * Replaces template variables in a SQL statement.
 *
 * Text inside comments and dollar-quoted strings is copied verbatim: it is not
 * executable SQL, and substituting a value there would corrupt the statement.
 * Single-quoted literals and double-quoted identifiers are interpolated like
 * any other code, because that is where a variable is meant to go
 * (`station_id = '$station'`, `FROM "$table"`); they are still scanned as units
 * so a `--` or `/*` inside them cannot be mistaken for a comment.
 */
export function interpolateSql(sql: string, scopedVars: ScopedVars, interpolate: SqlInterpolator): string {
  if (sql === '') {
    return sql;
  }

  // `$__interval` and `$__interval_ms` arrive through scopedVars when Grafana
  // supplies them. They are deliberately not synthesized here: an empty
  // placeholder would shadow the real interval in scenes or alerting callers
  // that compute it through a macro instead.
  const vars = scopedVars;

  let out = '';
  // Start of the current run of interpolatable SQL. Writing a skipped region
  // verbatim ends the run.
  let codeStart = 0;

  const flushCode = (end: number) => {
    if (end > codeStart) {
      out += interpolate(sql.slice(codeStart, end), vars, formatSqlInterpolation);
    }
  };

  const copyVerbatim = (start: number, end: number) => {
    flushCode(start);
    out += sql.slice(start, end);
    codeStart = end;
  };

  for (let i = 0; i < sql.length;) {
    const char = sql[i];

    if (char === '-' && sql[i + 1] === '-') {
      const lf = sql.indexOf('\n', i);
      const cr = sql.indexOf('\r', i);
      const candidates = [lf, cr].filter((index) => index >= 0);
      const end = candidates.length > 0 ? Math.min(...candidates) : sql.length;
      copyVerbatim(i, end);
      i = end;
      continue;
    }

    if (char === '/' && sql[i + 1] === '*') {
      const end = blockCommentEnd(sql, i);
      copyVerbatim(i, end);
      i = end;
      continue;
    }

    if (char === '$') {
      const end = dollarQuotedEnd(sql, i);
      if (end > i) {
        copyVerbatim(i, end);
        i = end;
        continue;
      }
    }

    const escapedString = (char === 'E' || char === 'e') && sql[i + 1] === "'";
    i =
      escapedString || char === "'"
        ? skipSingleQuoted(sql, escapedString ? i + 1 : i, escapedString)
        : char === '"'
          ? skipDoubleQuoted(sql, i)
          : i + 1;
  }

  flushCode(sql.length);
  return out;
}

/**
 * Returns the index just past the closing marker of the block comment starting
 * at `start`. PostgreSQL block comments nest, so the depth is counted rather
 * than stopping at the first closing marker.
 */
function blockCommentEnd(sql: string, start: number): number {
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

/**
 * Returns the index just past the closing quote of the string literal starting
 * at `start`, or the string length when it is unterminated. A doubled quote is
 * an escaped quote, not the end of the literal.
 */
function skipSingleQuoted(sql: string, start: number, backslashEscapes = false): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (backslashEscapes && sql[i] === '\\') {
      i++;
      continue;
    }
    if (sql[i] !== "'") {
      continue;
    }
    if (sql[i + 1] === "'") {
      i++;
      continue;
    }
    return i + 1;
  }
  return sql.length;
}

/** Returns the index just past the closing quote of a quoted identifier. */
function skipDoubleQuoted(sql: string, start: number): number {
  for (let i = start + 1; i < sql.length; i++) {
    if (sql[i] !== '"') {
      continue;
    }
    if (sql[i + 1] === '"') {
      i++;
      continue;
    }
    return i + 1;
  }
  return sql.length;
}

/**
 * Recognises a PostgreSQL dollar-quoted string (`$$body$$` or `$tag$body$tag$`).
 *
 * PostgreSQL only treats `$tag$` as an opener in a position where a string may
 * start, not after an identifier character; otherwise a variable such as
 * `$station` followed by a later `$` could be consumed as a quote. The current
 * scanner only calls this at a `$`, so requiring the preceding character to be
 * absent or non-identifier is sufficient here.
 */
function dollarQuotedEnd(sql: string, start: number): number {
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

  // A PostgreSQL tag cannot start with a digit. A positional parameter followed
  // by another `$` is not a quote either.
  if (i > start + 1 && /[0-9]/.test(sql[start + 1])) {
    return start;
  }

  const tag = sql.slice(start, i + 1);
  const close = sql.indexOf(tag, i + 1);
  // An opener with no matching closer is not a dollar quote. Treat it as
  // ordinary text so a later variable can still be interpolated and the
  // database reports its own syntax error rather than receiving stale input.
  return close < 0 ? start : close + tag.length;
}
