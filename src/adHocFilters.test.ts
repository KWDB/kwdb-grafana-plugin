import type { AdHocVariableFilter } from '@grafana/data';

import {
  addConditionsToBuilderSql,
  adHocCondition,
  adHocTables,
  applyAdHocFilters,
  isAdHocWrapped,
  isFilterableStatement,
  stripLeadingComments,
  quoteIdent,
  quoteLiteral,
  stripStatementTerminator,
  uniqueMetricFindValues,
} from './adHocFilters';
import type { KwdbQuery } from './types';

function filter(overrides: Partial<AdHocVariableFilter> = {}): AdHocVariableFilter {
  return { key: 'station_id', operator: '=', value: 'PV-A07', ...overrides };
}

describe('quoteIdent', () => {
  it('quotes and escapes identifiers', () => {
    expect(quoteIdent('station_id')).toBe('"station_id"');
    expect(quoteIdent('odd"name')).toBe('"odd""name"');
  });
});

describe('quoteLiteral', () => {
  it('quotes and escapes literals', () => {
    expect(quoteLiteral("PV'A07")).toBe("'PV''A07'");
  });
});

describe('adHocCondition', () => {
  it('renders a string equality filter', () => {
    expect(adHocCondition(filter())).toBe(`"station_id" = 'PV-A07'`);
  });

  it('renders a not-equal filter', () => {
    expect(adHocCondition(filter({ operator: '!=' }))).toBe(`"station_id" != 'PV-A07'`);
  });

  it('renders regex and negative-regex filters with KWDB operators', () => {
    expect(adHocCondition(filter({ operator: '=~', value: 'PV-A0[78]' }))).toBe(`"station_id" ~ 'PV-A0[78]'`);
    expect(adHocCondition(filter({ operator: '!~', value: 'PV-A0[78]' }))).toBe(`"station_id" !~ 'PV-A0[78]'`);
  });

  it.each(['<', '>', '<=', '>='])('renders the %s comparison operator', (operator) => {
    expect(adHocCondition(filter({ operator, value: '5' }))).toBe(`"station_id" ${operator} '5'`);
  });

  it('renders a multi-value equality filter as an IN list', () => {
    expect(adHocCondition(filter({ values: ['PV-A07', 'PV-A08'] }))).toBe(`"station_id" IN ('PV-A07', 'PV-A08')`);
  });

  it('renders a multi-value inequality filter as a NOT IN list', () => {
    expect(adHocCondition(filter({ operator: '!=', values: ['PV-A07', 'PV-A08'] }))).toBe(
      `"station_id" NOT IN ('PV-A07', 'PV-A08')`
    );
  });

  it('supports the Scenes multi-value operators', () => {
    expect(adHocCondition(filter({ operator: '=|', values: ['PV-A07', 'PV-A08'] }))).toBe(
      `"station_id" IN ('PV-A07', 'PV-A08')`
    );
    expect(adHocCondition(filter({ operator: '!=|', values: ['PV-A07', 'PV-A08'] }))).toBe(
      `"station_id" NOT IN ('PV-A07', 'PV-A08')`
    );
  });

  it('escapes filter values', () => {
    expect(adHocCondition(filter({ value: "PV'A07" }))).toBe(`"station_id" = 'PV''A07'`);
  });

  it('renders a dashboard variable inside a filter value', () => {
    expect(adHocCondition(filter({ value: '$station' }), (value) => value.replace('$station', 'PV-A07'))).toBe(
      `"station_id" = 'PV-A07'`
    );
  });

  it('ignores empty keys and unsupported operators but keeps an empty string filter', () => {
    expect(adHocCondition(filter({ key: '  ' }))).toBeUndefined();
    expect(adHocCondition(filter({ value: '' }))).toBe(`"station_id" = ''`);
    expect(adHocCondition(filter({ operator: 'contains' }))).toBeUndefined();
  });
});

describe('stripStatementTerminator', () => {
  it('removes trailing whitespace and semicolons', () => {
    expect(stripStatementTerminator('SELECT 1;  \n')).toBe('SELECT 1');
    expect(stripStatementTerminator('SELECT 1')).toBe('SELECT 1');
  });
});

describe('isFilterableStatement', () => {
  it.each(['SELECT 1', '  with x as (select 1) select * from x', '(SELECT 1)'])('accepts %s', (statement) => {
    expect(isFilterableStatement(statement)).toBe(true);
  });

  it.each(['SHOW TABLES', 'EXPLAIN SELECT 1', ''])('rejects %s', (statement) => {
    expect(isFilterableStatement(statement)).toBe(false);
  });

  it.each([
    '-- note\nSELECT 1',
    '/* hint */ SELECT 1',
    '/* outer /* inner */ */ SELECT 1',
    '-- one\n-- two\n  SELECT 1',
  ])('accepts a statement behind leading comments: %s', (statement) => {
    expect(isFilterableStatement(statement)).toBe(true);
  });

  it('rejects a statement whose only content is a comment', () => {
    expect(isFilterableStatement('-- nothing here')).toBe(false);
  });
});

describe('applyAdHocFilters', () => {
  it('returns the statement unchanged without conditions', () => {
    const sql = 'SELECT * FROM t';
    expect(applyAdHocFilters(sql, [])).toBe(sql);
  });

  it('wraps a SELECT in a subquery so the user statement is untouched', () => {
    const sql = 'SELECT * FROM t WHERE x = 1';
    expect(applyAdHocFilters(sql, [`"station_id" = 'PV-A07'`])).toBe(
      ['SELECT *', 'FROM (', sql, ') AS adhoc_filters', `WHERE "station_id" = 'PV-A07'`].join('\n')
    );
  });

  it('strips a trailing semicolon before wrapping', () => {
    expect(applyAdHocFilters('SELECT 1;', [`"a" = 'b'`])).toContain('FROM (\nSELECT 1\n) AS adhoc_filters');
  });

  it('does not wrap SHOW statements', () => {
    const sql = 'SHOW TABLES';
    expect(applyAdHocFilters(sql, [`"a" = 'b'`])).toBe(sql);
  });
});

describe('stripLeadingComments', () => {
  it('removes line and block comments', () => {
    expect(stripLeadingComments('-- a\n/* b */ SELECT 1')).toBe('SELECT 1');
  });

  it('leaves a statement without comments unchanged', () => {
    expect(stripLeadingComments('SELECT 1')).toBe('SELECT 1');
  });
});

describe('applyAdHocFilters with leading comments', () => {
  it('wraps a commented SELECT instead of silently dropping the filter', () => {
    const result = applyAdHocFilters('-- pick rows\nSELECT * FROM t', [`"a" = 'b'`]);
    expect(result).toContain('adhoc_filters');
    expect(result).toContain('SELECT * FROM t');
  });
});

describe('Ad Hoc wrapper idempotency', () => {
  it('does not nest a second wrapper when applied twice', () => {
    const once = applyAdHocFilters('SELECT * FROM t', [`"a" = '1'`]);
    const twice = applyAdHocFilters(once, [`"a" = '1'`]);

    expect(twice).toBe(once);
    expect(twice.match(/AS adhoc_filters/g)).toHaveLength(1);
    expect(twice.match(/"a" = '1'/g)).toHaveLength(1);
  });

  it('replaces the conditions when a different filter is applied to a wrapped statement', () => {
    const once = applyAdHocFilters('SELECT * FROM t', [`"a" = '1'`]);
    const updated = applyAdHocFilters(once, [`"b" = '2'`]);

    expect(updated).toContain(`"b" = '2'`);
    expect(updated).not.toContain(`"a" = '1'`);
    expect(updated.match(/AS adhoc_filters/g)).toHaveLength(1);
  });

  it('recognises only the wrapper shape it produces', () => {
    expect(isAdHocWrapped(applyAdHocFilters('SELECT * FROM t', [`"a" = '1'`]))).toBe(true);
    expect(isAdHocWrapped('SELECT * FROM t')).toBe(false);
  });
});

describe('adHocTables', () => {
  it('prefers the explicit Ad Hoc table', () => {
    const queries: KwdbQuery[] = [
      {
        refId: 'A',
        mode: 'downsampling',
        format: 'time_series',
        table: 'sensors',
        adHocTable: 'iot_db.devices',
      },
    ];
    expect(adHocTables(queries)).toEqual(['iot_db.devices']);
  });

  it('falls back to each builder table and removes duplicates', () => {
    const queries: KwdbQuery[] = [
      { refId: 'A', mode: 'downsampling', format: 'time_series', table: 'sensors' },
      { refId: 'B', mode: 'downsampling', format: 'time_series', table: 'sensors' },
      { refId: 'C', mode: 'latest', format: 'time_series', table: 'devices' },
    ];
    expect(adHocTables(queries)).toEqual(['sensors', 'devices']);
  });

  it('ignores Raw SQL targets without an explicit table', () => {
    expect(adHocTables([{ refId: 'A', mode: 'raw', format: 'table', rawSql: 'SELECT 1' }])).toEqual([]);
  });
});

describe('addConditionsToBuilderSql', () => {
  it('injects predicates before the builder WHERE expression', () => {
    const sql =
      'SELECT "station_id", avg("value") AS "value"\nFROM "t"\nWHERE "ts" >= $__timeFrom AND "ts" <= $__timeTo\nGROUP BY "station_id"';
    expect(addConditionsToBuilderSql(sql, [`"station_id" = 'PV-A07'`])).toContain(
      `WHERE "station_id" = 'PV-A07' AND "ts" >= $__timeFrom`
    );
  });
});

describe('uniqueMetricFindValues', () => {
  it('removes duplicates while preserving order', () => {
    expect(uniqueMetricFindValues(['PV-A07', 'PV-A08', 'PV-A07'])).toEqual([
      { text: 'PV-A07', value: 'PV-A07' },
      { text: 'PV-A08', value: 'PV-A08' },
    ]);
  });
});
