import type { ScopedVars, VariableWithMultiSupport } from '@grafana/data';

import { formatSqlInterpolation, interpolateSql, quoteSqlLiteral } from './sqlInterpolation';

function variable(overrides: Partial<VariableWithMultiSupport> = {}): VariableWithMultiSupport {
  return { multi: false, includeAll: false, ...overrides } as VariableWithMultiSupport;
}

// Stand-in for TemplateSrv.replace: only single-value scoped vars are resolved,
// which keeps these tests focused on formatting and region skipping.
function fakeInterpolate(target: string, scopedVars: ScopedVars, format?: string | Function): string {
  return target.replace(/\$\{?(\w+)\}?/g, (match: string, name: string) => {
    const scopedVar = scopedVars[name];
    if (!scopedVar) {
      return match;
    }
    const value = scopedVar.value as string | string[] | number;
    if (typeof format === 'function') {
      return String(format(value, variable()));
    }
    if (Array.isArray(value)) {
      return value.map((item) => `'${item.replace(/'/g, "''")}'`).join(',');
    }
    return String(value).replace(/'/g, "''");
  });
}

describe('formatSqlInterpolation', () => {
  it('escapes a single string value without adding quotes', () => {
    expect(formatSqlInterpolation("PV'A07", variable())).toBe("PV''A07");
  });

  it('quotes every value of a multi-value variable', () => {
    expect(formatSqlInterpolation(['PV-A07', "PV'A08"], variable({ multi: true }))).toBe("'PV-A07','PV''A08'");
  });

  it('quotes a single selected value of a multi-value variable', () => {
    // Grafana resolves a `multi` variable to an array even when one value is
    // selected, so the array branch (not the string branch) does the quoting.
    expect(formatSqlInterpolation(['PV-A07'], variable({ multi: true }))).toBe("'PV-A07'");
  });

  it('escapes rather than quotes a multi-value variable flattened to a string', () => {
    // Scoped variables and repeat variables reach the formatter as strings.
    // Quoting here would nest quotes inside an already quoted SQL literal.
    expect(formatSqlInterpolation("PV'A07", variable({ multi: true }))).toBe("PV''A07");
  });

  it('keeps a number unquoted', () => {
    expect(formatSqlInterpolation(15, variable())).toBe('15');
  });

  it('returns a custom All expression unquoted so SQL can use it as a pattern', () => {
    // Grafana hands the configured allValue to the formatter as a plain string
    // (the value it passes is `${value}`, not the option array). Returning it
    // unchanged is what lets `station_id LIKE '$station'` mean "all".
    const allVariable = variable({
      includeAll: true,
      allValue: 'PV-*',
      current: { text: 'All', value: '$__all' } as VariableWithMultiSupport['current'],
      options: [{ text: 'All', value: '$__all', selected: true }],
    });
    expect(formatSqlInterpolation('PV-*', allVariable)).toBe('PV-*');
  });

  it('does not invent an All value when none is configured', () => {
    // With includeAll but no custom allValue, Grafana passes the option array;
    // an empty selection therefore renders an empty list rather than `'*'`.
    expect(formatSqlInterpolation([], variable({ includeAll: true }))).toBe('');
  });
});

describe('quoteSqlLiteral', () => {
  it('doubles embedded quotes', () => {
    expect(quoteSqlLiteral("it's")).toBe("'it''s'");
  });
});

describe('interpolateSql', () => {
  it('replaces a variable inside a string literal', () => {
    const sql = "SELECT * FROM t WHERE station_id = '$station'";
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      "SELECT * FROM t WHERE station_id = 'PV-A07'"
    );
  });

  it('replaces a variable inside a quoted identifier', () => {
    const sql = 'SELECT * FROM "$table"';
    expect(interpolateSql(sql, { table: { value: 'sensors' } }, fakeInterpolate)).toBe('SELECT * FROM "sensors"');
  });

  it('leaves a variable in a line comment untouched', () => {
    const sql = 'SELECT 1 -- keep $station here\nFROM t';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(sql);
  });

  it('leaves a variable in a block comment untouched', () => {
    const sql = 'SELECT 1 /* keep $station here */ FROM t';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(sql);
  });

  it('handles nested block comments without leaking the comment into SQL', () => {
    const sql = 'SELECT /* outer /* inner */ $station */ 1';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(sql);
  });

  it('leaves a variable in a dollar-quoted string untouched', () => {
    const sql = 'SELECT $$ $station $$, $station';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      'SELECT $$ $station $$, PV-A07'
    );
  });

  it('does not treat a variable adjacent to a dollar sign as a quote opener', () => {
    const sql = 'SELECT $station$foo, $station';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).not.toContain(
      'SELECT $station$foo, $station'
    );
  });

  it('supports tagged dollar quoting and positional parameters', () => {
    const sql = 'SELECT $tag$ $station $tag$ AS a, $1, $station';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      'SELECT $tag$ $station $tag$ AS a, $1, PV-A07'
    );
  });

  it('does not treat a comment marker inside a string literal as a comment', () => {
    const sql = "SELECT '--not a comment $station' AS s";
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      "SELECT '--not a comment PV-A07' AS s"
    );
  });

  it('does not stop at an escaped quote inside a string literal', () => {
    const sql = "SELECT 'it''s $station' AS s";
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe("SELECT 'it''s PV-A07' AS s");
  });

  it('handles CR-only line comments', () => {
    const sql = 'SELECT 1 -- $station\rFROM t WHERE station_id = $station';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      'SELECT 1 -- $station\rFROM t WHERE station_id = PV-A07'
    );
  });

  it('does not treat an escaped quote in an E-string as the end of the literal', () => {
    const sql = "SELECT E'it\\\\'s $station', $station";
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      "SELECT E'it\\\\'s PV-A07', PV-A07"
    );
  });

  it('leaves an unknown variable as written', () => {
    const sql = 'SELECT $missing';
    expect(interpolateSql(sql, {}, fakeInterpolate)).toBe(sql);
  });

  it('returns an empty statement unchanged', () => {
    expect(interpolateSql('', {}, fakeInterpolate)).toBe('');
  });

  it('resolves a built-in interval variable in a time bucket', () => {
    const sql = "SELECT time_bucket(k_timestamp, '$__interval') AS time FROM t";
    expect(interpolateSql(sql, { __interval: { text: '5m', value: '5m' } }, fakeInterpolate)).toBe(
      "SELECT time_bucket(k_timestamp, '5m') AS time FROM t"
    );
  });

  it('keeps Grafana time macros for the backend to expand', () => {
    const sql = 'SELECT * FROM t WHERE $__timeFilter(k_timestamp) AND station_id = $station';
    expect(interpolateSql(sql, { station: { value: 'PV-A07' } }, fakeInterpolate)).toBe(
      'SELECT * FROM t WHERE $__timeFilter(k_timestamp) AND station_id = PV-A07'
    );
  });
});

/**
 * Mirrors how Grafana's `TemplateSrv` invokes a custom formatter: the resolved
 * value is an option array for `multi`/`includeAll` variables and a plain value
 * otherwise. The earlier tests above use a hand-built variable, which cannot
 * show whether quoting happens on the real call path; these do.
 */
function formatterFor(scoped: ScopedVars) {
  return (target: string, vars: ScopedVars): string =>
    target.replace(/\$\{?(\w+)(?::\w+)?\}?/g, (match: string, name: string) => {
      const entry = vars[name] ?? scoped[name];
      if (!entry || entry.value === undefined || entry.value === null) {
        return match;
      }
      return formatSqlInterpolation(entry.value as string | string[] | number, variable({ multi: true }));
    });
}

describe('multi-value and All on the real call shape', () => {
  it('renders an IN list for two selected values', () => {
    const sql = 'SELECT count(*) FROM t WHERE station_id IN ($station)';
    const vars = { station: { value: ['PV-A07', 'PV-A08'] } };
    expect(interpolateSql(sql, vars, formatterFor(vars))).toBe(
      "SELECT count(*) FROM t WHERE station_id IN ('PV-A07','PV-A08')"
    );
  });

  it('renders a one-element list when a single value is selected', () => {
    const sql = 'SELECT count(*) FROM t WHERE station_id IN ($station)';
    const vars = { station: { value: ['PV-A07'] } };
    expect(interpolateSql(sql, vars, formatterFor(vars))).toBe("SELECT count(*) FROM t WHERE station_id IN ('PV-A07')");
  });

  it('escapes quotes inside every value of the list', () => {
    const sql = 'SELECT count(*) FROM t WHERE station_id IN ($station)';
    const vars = { station: { value: ["PV'A07", "PV'B08"] } };
    expect(interpolateSql(sql, vars, formatterFor(vars))).toBe(
      "SELECT count(*) FROM t WHERE station_id IN ('PV''A07','PV''B08')"
    );
  });
});

describe('adversarial variable values', () => {
  const interpolate = (sql: string, value: string | string[]) => {
    const vars: ScopedVars = { v: { value } };
    return interpolateSql(sql, vars, formatterFor(vars));
  };

  it('keeps a quote inside the literal instead of closing it', () => {
    expect(interpolate("SELECT * FROM t WHERE a = '$v'", "x' OR true --")).toBe(
      "SELECT * FROM t WHERE a = 'x'' OR true --'"
    );
  });

  it('does not let a semicolon start a second statement', () => {
    expect(interpolate("SELECT * FROM t WHERE a = '$v'", "x'; DROP TABLE t; --")).toBe(
      "SELECT * FROM t WHERE a = 'x''; DROP TABLE t; --'"
    );
  });

  it('neutralises comment openers inside the literal', () => {
    expect(interpolate("SELECT * FROM t WHERE a = '$v'", 'x/*y*/z')).toBe("SELECT * FROM t WHERE a = 'x/*y*/z'");
    expect(interpolate("SELECT * FROM t WHERE a = '$v'", 'x--y')).toBe("SELECT * FROM t WHERE a = 'x--y'");
  });

  it('neutralises dollar-quoting inside the literal', () => {
    expect(interpolate("SELECT * FROM t WHERE a = '$v'", '$$x$$')).toBe("SELECT * FROM t WHERE a = '$$x$$'");
  });
});
