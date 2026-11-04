import type { KwdbVariableQuery } from './types';

const VARIABLE_QUERY_RE = /^(tag_values|tables|columns)\s*\((.*)\)$/i;

type ArgumentLabel = 'table' | 'tag column';

/** Reads a required string field from a structured (untyped dashboard JSON) query. */
function requireString(value: unknown, label: ArgumentLabel, message: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(message.includes(label) ? message : `${message} (${label} must be a non-empty string)`);
  }
  return value;
}

/**
 * Rejects the few characters a table or tag column name cannot contain in the
 * rendered definition. Parentheses would break the `fn(args)` grammar (and used
 * to make `columns(a)(b)` parse as table `a)(b`), and line breaks cannot be
 * matched by the single-line pattern.
 */
function assertSupportedArgument(value: string, label: ArgumentLabel): void {
  if (/[()]/.test(value)) {
    throw new Error(`Variable query ${label} "${value}" cannot contain "(" or ")"`);
  }
  if (/[\r\n]/.test(value)) {
    throw new Error(`Variable query ${label} "${value}" cannot contain a line break`);
  }
}

/**
 * Splits a comma-separated argument list, honouring single, double and back
 * quotes. A naive `split(',')` breaks `tag_values("my,sensors", device_id)`,
 * which is a legal (if unusual) table name.
 *
 * Inside a double-quoted argument a doubled double quote (`""`) is an escaped
 * quote, mirroring how identifiers are quoted in SQL and how
 * `buildVariableQueryString` renders them.
 */
function splitArguments(raw: string): string[] {
  const args: string[] = [];
  let current = '';
  let quote: string | null = null;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      current += char;
      if (char === quote) {
        if (quote === '"' && raw[index + 1] === '"') {
          current += raw[index + 1];
          index += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      args.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  args.push(current);

  return args;
}

/** Removes the quotes around an argument, unescaping `""` for double quotes. */
function unquoteArgument(raw: string): string {
  const value = raw.trim();
  if (value.length < 2) {
    return value;
  }
  const first = value[0];
  const last = value[value.length - 1];
  if (first === '"' && last === '"') {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  if ((first === "'" && last === "'") || (first === '`' && last === '`')) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Parses a template variable query into its structured form. `query` may be a
 * structured KwdbVariableQuery, a raw string such as `tag_values(table, column)`,
 * or null/undefined.
 *
 * The returned object is always a fresh copy, so callers cannot mutate the
 * parsed result by holding on to the object they passed in.
 */
export function parseVariableQuery(query: unknown): KwdbVariableQuery {
  if (query && typeof query === 'object' && typeof (query as KwdbVariableQuery).queryType === 'string') {
    const parsed = query as KwdbVariableQuery;
    switch (parsed.queryType) {
      case 'tables':
        return { queryType: 'tables' };
      case 'columns': {
        const table = requireString(parsed.table, 'table', 'Variable query "columns" requires a table');
        assertSupportedArgument(table, 'table');
        return { queryType: 'columns', table };
      }
      case 'tagValues': {
        const table = requireString(
          parsed.table,
          'table',
          'Variable query "tagValues" requires a table and a tag column'
        );
        const column = requireString(
          parsed.column,
          'tag column',
          'Variable query "tagValues" requires a table and a tag column'
        );
        assertSupportedArgument(table, 'table');
        assertSupportedArgument(column, 'tag column');
        return { queryType: 'tagValues', table, column };
      }
      default:
        throw new Error(
          `Unsupported variable query type "${parsed.queryType}". Use tag_values(table, column), tables() or columns(table).`
        );
    }
  }

  // Trailing whitespace and semicolons are stripped together so that
  // `tables() ;  ;` and `tables();` are both accepted.
  const text = String(query ?? '')
    .trim()
    .replace(/[\s;]+$/, '');
  const match = VARIABLE_QUERY_RE.exec(text);
  if (!match) {
    throw new Error('Unsupported variable query. Use tag_values(table, column), tables() or columns(table).');
  }
  const fn = match[1].toLowerCase();
  const args = match[2].trim() ? splitArguments(match[2]).map((part) => unquoteArgument(part)) : [];

  switch (fn) {
    case 'tables':
      if (args.length !== 0) {
        throw new Error('Variable query tables() takes no arguments');
      }
      return { queryType: 'tables' };
    case 'columns':
      if (args.length !== 1 || !args[0]) {
        throw new Error('Variable query columns(table) requires exactly one table argument');
      }
      assertSupportedArgument(args[0], 'table');
      return { queryType: 'columns', table: args[0] };
    default:
      if (args.length !== 2 || !args[0] || !args[1]) {
        throw new Error('Variable query tag_values(table, column) requires exactly two arguments');
      }
      assertSupportedArgument(args[0], 'table');
      assertSupportedArgument(args[1], 'tag column');
      return { queryType: 'tagValues', table: args[0], column: args[1] };
  }
}

/**
 * Renders a single argument. A value that contains a comma or one of the quote
 * characters is wrapped in double quotes and its double quotes are doubled, so
 * that `parseVariableQuery` reads it back unchanged instead of treating a comma
 * as an argument separator.
 */
function renderArgument(value: string, label: ArgumentLabel): string {
  assertSupportedArgument(value, label);
  if (!/[,"'`]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '""')}"`;
}

/**
 * Renders the canonical raw query string for a structured variable query.
 *
 * The output always round-trips through `parseVariableQuery`, for any table or
 * tag column name that does not contain parentheses or a line break: those are
 * rejected here with a readable error instead of producing a definition the
 * plugin itself cannot parse back.
 */
export function buildVariableQueryString(query: KwdbVariableQuery): string {
  switch (query.queryType) {
    case 'tables':
      return 'tables()';
    case 'columns':
      if (!query.table?.trim()) {
        throw new Error('Variable query "columns" requires a table');
      }
      return `columns(${renderArgument(query.table, 'table')})`;
    case 'tagValues':
      if (!query.table?.trim() || !query.column?.trim()) {
        throw new Error('Variable query "tagValues" requires a table and a tag column');
      }
      return `tag_values(${renderArgument(query.table, 'table')}, ${renderArgument(query.column, 'tag column')})`;
    default:
      throw new Error(`Unsupported variable query type "${(query as KwdbVariableQuery).queryType}"`);
  }
}
