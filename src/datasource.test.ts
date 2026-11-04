import type { DataSourceInstanceSettings, ScopedVars } from '@grafana/data';
import type { TemplateSrv } from '@grafana/runtime';

import { KwdbDataSource } from './datasource';
import type { KwdbDataSourceOptions, KwdbQuery } from './types';

function makeTemplateSrv(): TemplateSrv & { replace: jest.Mock; containsTemplate: jest.Mock } {
  const replace = jest.fn((target: string, scopedVars: ScopedVars, format?: string | Function) => {
    // Minimal stand-in for the real service: resolve single-value variables and
    // apply the custom SQL formatter when one is supplied.
    return target.replace(/\$\{?(\w+)\}?/g, (match: string, name: string) => {
      const scopedVar = scopedVars?.[name];
      if (!scopedVar) {
        return match;
      }
      const value = scopedVar.value as string | string[] | number;
      if (typeof format === 'function') {
        return String(format(value, { multi: false, includeAll: false }));
      }
      return typeof value === 'string' ? value : String(value);
    });
  });
  const containsTemplate = jest.fn((target: string) => /\$\w+|\$\{\w+\}/.test(target ?? ''));

  return { replace, containsTemplate } as unknown as TemplateSrv & {
    replace: jest.Mock;
    containsTemplate: jest.Mock;
  };
}

function makeDataSource(templateSrv: TemplateSrv): KwdbDataSource {
  const instanceSettings = {
    uid: 'kwdb-tsdb',
    type: 'kwdb-tsdb-datasource',
    name: 'KWDB TSDB',
    access: 'proxy',
    url: '',
    jsonData: {},
    meta: {},
    readOnly: false,
  } as unknown as DataSourceInstanceSettings<KwdbDataSourceOptions>;

  return new KwdbDataSource(instanceSettings, templateSrv);
}

function rawQuery(rawSql: string): KwdbQuery {
  return { refId: 'A', mode: 'raw', format: 'table', rawSql };
}

describe('KwdbDataSource.applyTemplateVariables', () => {
  it('interpolates a dashboard variable in Raw SQL', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);

    const result = ds.applyTemplateVariables(rawQuery('SELECT * FROM t WHERE station_id = $station'), {
      station: { value: 'PV-A07' },
    });

    expect(result.rawSql).toBe('SELECT * FROM t WHERE station_id = PV-A07');
  });

  it('escapes quotes in an interpolated value', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);

    const result = ds.applyTemplateVariables(rawQuery("SELECT * FROM t WHERE station_id = '$station'"), {
      station: { value: "PV'A07" },
    });

    expect(result.rawSql).toBe("SELECT * FROM t WHERE station_id = 'PV''A07'");
  });

  it('interpolates a chart interval variable', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);

    const result = ds.applyTemplateVariables(rawQuery('SELECT time_bucket(k_timestamp, $interval) AS time FROM t'), {
      interval: { value: '15m' },
    });

    expect(result.rawSql).toBe('SELECT time_bucket(k_timestamp, 15m) AS time FROM t');
  });

  it('leaves Grafana time macros for the backend to expand', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);

    const result = ds.applyTemplateVariables(
      rawQuery('SELECT * FROM t WHERE $__timeFilter(k_timestamp) AND station_id = $station'),
      { station: { value: 'PV-A07' } }
    );

    expect(result.rawSql).toBe('SELECT * FROM t WHERE $__timeFilter(k_timestamp) AND station_id = PV-A07');
  });

  it('does not interpolate variables inside comments', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);
    const sql = 'SELECT * FROM t -- $station\nWHERE station_id = $station';

    const result = ds.applyTemplateVariables(rawQuery(sql), { station: { value: 'PV-A07' } });

    expect(result.rawSql).toBe('SELECT * FROM t -- $station\nWHERE station_id = PV-A07');
  });

  it('returns the same object when the statement has no variables', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);
    const query = rawQuery('SELECT 1');

    expect(ds.applyTemplateVariables(query, {})).toBe(query);
  });

  it('returns the query unchanged when there is no SQL yet', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);
    const query: KwdbQuery = { refId: 'A', mode: 'downsampling', format: 'time_series', table: 'sensors' };

    expect(ds.applyTemplateVariables(query, { station: { value: 'PV-A07' } })).toBe(query);
  });

  it('keeps the builder fields used by the query editor', () => {
    const templateSrv = makeTemplateSrv();
    const ds = makeDataSource(templateSrv);
    const query: KwdbQuery = {
      refId: 'A',
      mode: 'downsampling',
      format: 'time_series',
      table: 'sensors',
      timeColumn: 'ts',
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
      rawSql: 'SELECT time_bucket(ts, $interval) FROM sensors',
    };

    const result = ds.applyTemplateVariables(query, { interval: { value: '5m' } });

    expect(result.rawSql).toContain(`time_bucket("ts", '5m') AS "time"`);
    expect(result.rawSql).toContain('avg("temperature")');
    expect(result.mode).toBe('downsampling');
    expect(result.table).toBe('sensors');
    expect(result.metrics).toEqual([{ column: 'temperature', aggregation: 'avg' }]);
  });
});

describe('KwdbDataSource.targetContainsTemplate', () => {
  it('reports a query that still contains a variable', () => {
    const ds = makeDataSource(makeTemplateSrv());
    expect(ds.targetContainsTemplate(rawQuery('SELECT * FROM t WHERE station_id = $station'))).toBe(true);
  });

  it('reports a query without variables', () => {
    const ds = makeDataSource(makeTemplateSrv());
    expect(ds.targetContainsTemplate(rawQuery('SELECT 1'))).toBe(false);
  });

  it('does not report backend time macros as dashboard variables', () => {
    const ds = makeDataSource(makeTemplateSrv());
    expect(ds.targetContainsTemplate(rawQuery('SELECT * FROM t WHERE $__timeFilter(ts) AND ts >= $__timeFrom'))).toBe(
      false
    );
  });

  it('still reports a real variable alongside a time macro', () => {
    const ds = makeDataSource(makeTemplateSrv());
    expect(
      ds.targetContainsTemplate(rawQuery('SELECT * FROM t WHERE $__timeFilter(ts) AND station_id = $station'))
    ).toBe(true);
  });

  it('reports false when the query has no SQL', () => {
    const ds = makeDataSource(makeTemplateSrv());
    expect(ds.targetContainsTemplate({ refId: 'A', mode: 'raw', format: 'table' })).toBe(false);
  });
});

describe('KwdbDataSource builder interpolation', () => {
  const builder = (overrides: Partial<KwdbQuery> = {}): KwdbQuery => ({
    refId: 'A',
    mode: 'downsampling',
    format: 'time_series',
    table: 'sensors',
    timeColumn: 'ts',
    interval: '5m',
    metrics: [{ column: 'temperature', aggregation: 'avg' }],
    ...overrides,
  });

  it('expands a dashboard variable used as the builder interval', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const result = ds.applyTemplateVariables(builder({ interval: '${bucket}' }), { bucket: { value: '15m' } });

    expect(result.rawSql).toContain(`time_bucket("ts", '15m')`);
    expect(result.rawSql).not.toContain('${bucket}');
  });

  it('expands a dashboard variable in an event window condition', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const result = ds.applyTemplateVariables(
      builder({
        mode: 'window',
        windowType: 'EVENT_WINDOW',
        eventStartCond: "status = '$status'",
        eventEndCond: 'status = 0',
      }),
      { status: { value: '1' } }
    );

    expect(result.rawSql).toContain("EVENT_WINDOW(status = '1', status = 0)");
  });

  it('expands $__interval supplied by Grafana', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const result = ds.applyTemplateVariables(builder({ interval: '$__interval' }), {
      __interval: { text: '1m', value: '1m' },
    });

    expect(result.rawSql).toContain(`time_bucket("ts", '1m')`);
  });

  it('renders Ad Hoc conditions after interpolation, without double escaping', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const result = ds.applyTemplateVariables(builder(), { bucket: { value: '5m' }, station: { value: 'PV-A07' } }, [
      { key: 'station_id', operator: '=', value: '$station' },
    ]);

    expect(result.rawSql).toContain(`time_bucket("ts", '5m')`);
    expect(result.rawSql).toContain(`"station_id" = 'PV-A07'`);
    expect(result.rawSql).not.toContain(`''PV-A07''`);
  });

  it('interpolates a persisted builder statement when the table is incomplete', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const query: KwdbQuery = {
      refId: 'A',
      mode: 'downsampling',
      format: 'time_series',
      rawSql: 'SELECT $station AS s',
    };

    expect(ds.applyTemplateVariables(query, { station: { value: 'PV-A07' } }).rawSql).toBe('SELECT PV-A07 AS s');
  });
});

describe('KwdbDataSource Ad Hoc filters', () => {
  it('applies a Raw SQL filter in a documented subquery fallback', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const filters = [{ key: 'station_id', operator: '=', value: 'PV-A07' }];

    const result = ds.applyTemplateVariables(rawQuery('SELECT * FROM sensors'), {}, filters);

    expect(result.rawSql).toContain('FROM (\nSELECT * FROM sensors\n) AS adhoc_filters');
    expect(result.rawSql).toContain(`WHERE "station_id" = 'PV-A07'`);
  });

  it('filters builder rows before aggregation and LIMIT', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const filters = [{ key: 'station_id', operator: '=', value: 'PV-A07' }];
    const query: KwdbQuery = {
      refId: 'A',
      mode: 'downsampling',
      format: 'time_series',
      table: 'sensors',
      timeColumn: 'ts',
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
      tags: ['station_id'],
    };

    const result = ds.applyTemplateVariables(query, {}, filters);

    const sql = result.rawSql ?? '';
    const sourceWhere = sql.indexOf(`"station_id" = 'PV-A07'`);
    const groupBy = sql.indexOf('GROUP BY');
    expect(sourceWhere).toBeGreaterThan(-1);
    expect(sourceWhere).toBeLessThan(groupBy);
    expect(sql).not.toContain('adhoc_filters');
  });

  it('filters builder rows even when the filter tag is not selected', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const filters = [{ key: 'station_id', operator: '=', value: 'PV-A07' }];
    const query: KwdbQuery = {
      refId: 'A',
      mode: 'downsampling',
      format: 'time_series',
      table: 'sensors',
      timeColumn: 'ts',
      metrics: [{ column: 'temperature', aggregation: 'avg' }],
    };

    const result = ds.applyTemplateVariables(query, {}, filters);

    expect(result.rawSql).toContain(`WHERE "station_id" = 'PV-A07'`);
    expect(result.rawSql).not.toContain('adhoc_filters');
  });

  it('expands dashboard variables inside filter values', () => {
    const ds = makeDataSource(makeTemplateSrv());
    const filters = [{ key: 'station_id', operator: '=', value: '$station' }];

    const result = ds.applyTemplateVariables(
      rawQuery('SELECT * FROM sensors'),
      { station: { value: 'PV-A07' } },
      filters
    );

    expect(result.rawSql).toContain(`"station_id" = 'PV-A07'`);
  });
});

describe('KwdbDataSource Ad Hoc metadata', () => {
  it('uses the explicit Ad Hoc table for Raw SQL', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    const getResource = jest.spyOn(ds, 'getResource').mockResolvedValue(['station_id']);

    const result = await ds.getTagKeys({
      filters: [],
      queries: [{ refId: 'A', mode: 'raw', format: 'table', adHocTable: 'station_telemetry' }],
    });

    expect(getResource).toHaveBeenCalledWith('/tag-keys?table=station_telemetry');
    expect(result).toEqual([{ text: 'station_id', value: 'station_id' }]);
  });

  it('uses /tag-keys for the first builder table', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    const getResource = jest.spyOn(ds, 'getResource').mockResolvedValue(['station_id', 'region_code']);

    const result = await ds.getTagKeys({
      filters: [],
      queries: [{ refId: 'A', mode: 'downsampling', format: 'time_series', table: 'station_telemetry' }],
    });

    expect(getResource).toHaveBeenCalledWith('/tag-keys?table=station_telemetry');
    expect(result).toEqual([
      { text: 'station_id', value: 'station_id' },
      { text: 'region_code', value: 'region_code' },
    ]);
  });

  it('returns no keys before any query declares an Ad Hoc table', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    const getResource = jest.spyOn(ds, 'getResource');

    await expect(ds.getTagKeys({ filters: [] })).resolves.toEqual([]);
    expect(getResource).not.toHaveBeenCalled();
  });

  it('reuses the last explicit table for the legacy picker call without queries', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    const getResource = jest.spyOn(ds, 'getResource').mockResolvedValue(['station_id']);
    await ds.getTagKeys({
      filters: [],
      queries: [{ refId: 'A', mode: 'raw', format: 'table', adHocTable: 'station_telemetry' }],
    });
    getResource.mockClear();

    await expect(ds.getTagKeys({ filters: [] })).resolves.toEqual([{ text: 'station_id', value: 'station_id' }]);
    expect(getResource).toHaveBeenCalledWith('/tag-keys?table=station_telemetry');
  });

  it('uses /tag-values only for tables that declare the key', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    const getResource = jest
      .spyOn(ds, 'getResource')
      .mockImplementation((path: string) =>
        Promise.resolve(
          path.startsWith('/tag-keys') && path.includes('station_telemetry')
            ? ['station_id', 'region_code']
            : path.startsWith('/tag-values')
              ? ['PV-A07', 'PV-A08']
              : []
        )
      );

    const result = await ds.getTagValues({
      key: 'station_id',
      filters: [],
      queries: [
        { refId: 'A', mode: 'raw', format: 'table', adHocTable: 'station_telemetry' },
        { refId: 'B', mode: 'downsampling', format: 'time_series', table: 'inverter_telemetry' },
      ],
    });

    expect(getResource).toHaveBeenCalledWith('/tag-values?table=station_telemetry&column=station_id');
    expect(getResource).not.toHaveBeenCalledWith('/tag-values?table=inverter_telemetry&column=station_id');
    expect(result).toHaveLength(2);
  });

  it('ignores a table whose metadata request fails instead of rejecting the picker', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    jest.spyOn(ds, 'getResource').mockImplementation((path: string) => {
      if (path.includes('broken_table')) {
        return Promise.reject(new Error('relation does not exist'));
      }
      return Promise.resolve(['station_id']);
    });

    await expect(
      ds.getTagKeys({
        filters: [],
        queries: [
          { refId: 'A', mode: 'raw', format: 'table', adHocTable: 'broken_table' },
          { refId: 'B', mode: 'raw', format: 'table', adHocTable: 'station_telemetry' },
        ],
      })
    ).resolves.toEqual([{ text: 'station_id', value: 'station_id' }]);
  });

  it('keeps the remembered table when a later call passes an empty query list', async () => {
    const ds = makeDataSource(makeTemplateSrv());
    const getResource = jest.spyOn(ds, 'getResource').mockResolvedValue(['station_id']);
    await ds.getTagKeys({
      filters: [],
      queries: [{ refId: 'A', mode: 'raw', format: 'table', adHocTable: 'station_telemetry' }],
    });
    getResource.mockClear();

    await expect(ds.getTagKeys({ filters: [], queries: [] })).resolves.toEqual([
      { text: 'station_id', value: 'station_id' },
    ]);
    expect(getResource).toHaveBeenCalledWith('/tag-keys?table=station_telemetry');
  });
});
