import { expect, test } from '@grafana/plugin-e2e';
import { e2eConfig } from './config';
import {
  type DataFrame,
  expectQuerySucceeded,
  fieldNames,
  rowCount,
  setFormat,
  setMode,
  setQueryTimeRange,
  setRawSql,
  skipIfEdgeTableUnavailable,
} from './helpers';

// These specs drive the *plugin* with data shapes that are awkward for its own
// logic: a NULL metric, rows stored out of time order, and tag values that need
// SQL quoting. They deliberately do not assert on KWDB's query semantics - only
// on the SQL the plugin generates, the frames it builds, and the errors it does
// or does not surface.

interface DashboardVariable {
  [key: string]: unknown;
}

function adHocVariable(datasource: { type: string; uid: string }, filters: Array<Record<string, unknown>>) {
  return {
    name: 'filter',
    type: 'adhoc',
    datasource,
    filters,
    baseFilters: [],
    defaultKeys: [],
  };
}

function adHocDashboard(
  uid: string,
  datasource: { type: string; uid: string },
  filters: Array<Record<string, unknown>>
) {
  return {
    title: `KWDB edge ${uid}`,
    uid,
    schemaVersion: 39,
    editable: true,
    time: { from: e2eConfig.edgeFrom, to: e2eConfig.edgeTo },
    templating: { list: [adHocVariable(datasource, filters)] },
    panels: [
      {
        id: 1,
        title: 'Edge panel',
        type: 'table',
        gridPos: { h: 8, w: 24, x: 0, y: 0 },
        datasource,
        targets: [
          {
            refId: 'A',
            datasource,
            mode: 'raw',
            format: 'table',
            rawSql: `SELECT ts, device_id, site, value FROM ${e2eConfig.edgeTable}`,
            adHocTable: e2eConfig.edgeTable,
          },
        ],
      },
    ],
  };
}

function valueIndex(frame: DataFrame): number {
  const names = fieldNames(frame);
  const idx = names.indexOf(e2eConfig.edgeMetric);
  expect(idx, `frame is missing the metric field ${e2eConfig.edgeMetric}`).toBeGreaterThanOrEqual(0);
  return idx;
}

test.describe('plugin behavior on adversarial data', () => {
  test.describe.configure({ timeout: 120_000 });

  test('table format keeps a NULL metric instead of failing the frame', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfEdgeTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await setQueryTimeRange(panelEditPage, { from: e2eConfig.edgeFrom, to: e2eConfig.edgeTo });
    await setMode(page, 'Raw SQL');
    await setFormat(page, 'Table');
    await setRawSql(
      page,
      `SELECT ${e2eConfig.edgeTimeColumn}, ${e2eConfig.edgeTagColumn}, ${e2eConfig.edgeMetric} ` +
        `FROM ${e2eConfig.edgeTable} ORDER BY ${e2eConfig.edgeTimeColumn}`
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    const frame = frames[0];
    const values = frame.data?.values?.[valueIndex(frame)] ?? [];
    expect(values.length, 'expected the seeded rows').toBeGreaterThan(0);
    expect(
      values.some((value) => value === null),
      'the NULL metric must survive as a NULL value, not turn into 0 or an error'
    ).toBeTruthy();
  });

  test('time_series format sorts rows that arrive out of order', async ({ readProvisionedDataSource, page }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfEdgeTableUnavailable(page, ds.uid);

    // Driven through the dashboard API rather than the panel editor: the behavior under
    // test is the backend's time sorting, and the editor's format picker is already
    // covered by raw-sql.spec.ts.
    const uid = `kwdb-edge-sort-${Date.now()}`;
    const body = {
      title: `KWDB edge sort ${uid}`,
      uid,
      schemaVersion: 39,
      editable: true,
      time: { from: e2eConfig.edgeFrom, to: e2eConfig.edgeTo },
      panels: [
        {
          id: 1,
          title: 'Edge sort panel',
          type: 'table',
          gridPos: { h: 8, w: 24, x: 0, y: 0 },
          datasource: { type: ds.type, uid: ds.uid },
          targets: [
            {
              refId: 'A',
              datasource: { type: ds.type, uid: ds.uid },
              mode: 'raw',
              format: 'time_series',
              // device-b rows are stored out of order on purpose, and DESC forces the
              // database to hand them back in the opposite of the required order.
              rawSql:
                `SELECT ${e2eConfig.edgeTimeColumn}, ${e2eConfig.edgeTagColumn}, ${e2eConfig.edgeMetric} ` +
                `FROM ${e2eConfig.edgeTable} ORDER BY ${e2eConfig.edgeTimeColumn} DESC`,
            },
          ],
        },
      ],
    };

    await page.request.post('/api/dashboards/db', { data: { dashboard: body, overwrite: true, folderUid: '' } });

    try {
      const responsePromise = page.waitForResponse((response) => response.url().includes('/api/ds/query'), {
        timeout: 60_000,
      });
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;

      const frames = await expectQuerySucceeded(response);
      const timeField = frames.flatMap((frame) => frame.schema?.fields ?? []).find((field) => field.name === 'time');
      expect(timeField, 'a time_series query must expose a field named "time"').toBeTruthy();

      const timeValues = frames.flatMap((frame) => {
        const idx = (frame.schema?.fields ?? []).findIndex((field) => field.name === 'time');
        return idx >= 0 ? (frame.data?.values?.[idx] ?? []) : [];
      });
      expect(timeValues.length, 'expected the seeded rows').toBeGreaterThan(0);

      const ascending = [...timeValues].sort((a, b) => String(a).localeCompare(String(b)));
      expect(timeValues, 'the plugin must sort rows by time even when SQL returns them descending').toEqual(ascending);
    } finally {
      await page.request.delete(`/api/dashboards/uid/${uid}`);
    }
  });

  test('an Ad Hoc filter quotes tag values containing a comma and a quote', async ({
    readProvisionedDataSource,
    page,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfEdgeTableUnavailable(page, ds.uid);

    const uid = `kwdb-edge-adhoc-${Date.now()}`;
    const filters = [
      { key: e2eConfig.edgeTagColumn, operator: '=', value: 'edge,comma', origin: 'dashboard' },
      { key: 'site', operator: '=', value: "site's alpha", origin: 'dashboard' },
    ];
    const body = adHocDashboard(uid, { type: ds.type, uid: ds.uid }, filters);

    await page.request.post('/api/dashboards/db', { data: { dashboard: body, overwrite: true, folderUid: '' } });

    try {
      const responsePromise = page.waitForResponse(
        (response) =>
          response.url().includes('/api/ds/query') &&
          (response.request().postData() ?? '').includes(e2eConfig.edgeTagColumn),
        { timeout: 60_000 }
      );
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;

      const frames = await expectQuerySucceeded(response);
      // Only the comma/quote row matches, so a broken quote or a comma treated as a
      // value separator shows up as zero rows rather than a silent wrong answer.
      expect(rowCount(frames[0]), 'the filter must select exactly the comma/quote row').toBe(1);

      const target = (
        JSON.parse(response.request().postData() ?? '{}') as {
          queries?: Array<{ adHocFilters?: Array<{ key: string; condition: string }> }>;
        }
      ).queries?.[0];
      const applied = target?.adHocFilters ?? [];
      expect(applied.map((entry) => entry.key)).toContain(e2eConfig.edgeTagColumn);
      // Grafana sends the prepared predicate, so this asserts the plugin's own
      // escaping: a doubled quote inside the literal and the comma left intact.
      expect(applied.map((entry) => entry.condition)).toContain(`"site" = 'site''s alpha'`);
    } finally {
      await page.request.delete(`/api/dashboards/uid/${uid}`);
    }
  });

  test('a builder query over the edge table returns buckets without a plugin error', async ({
    readProvisionedDataSource,
    page,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfEdgeTableUnavailable(page, ds.uid);

    const uid = `kwdb-edge-builder-${Date.now()}`;
    const body = {
      title: `KWDB edge builder ${uid}`,
      uid,
      schemaVersion: 39,
      editable: true,
      time: { from: e2eConfig.edgeFrom, to: e2eConfig.edgeTo },
      panels: [
        {
          id: 1,
          title: 'Edge builder panel',
          type: 'table',
          gridPos: { h: 8, w: 24, x: 0, y: 0 },
          datasource: { type: ds.type, uid: ds.uid },
          targets: [
            {
              refId: 'A',
              datasource: { type: ds.type, uid: ds.uid },
              mode: 'downsampling',
              format: 'time_series',
              table: e2eConfig.edgeTable,
              timeColumn: e2eConfig.edgeTimeColumn,
              interval: '5m',
              tags: [e2eConfig.edgeTagColumn],
              metrics: [{ column: e2eConfig.edgeMetric, aggregation: 'avg' }],
            },
          ],
        },
      ],
    };

    await page.request.post('/api/dashboards/db', { data: { dashboard: body, overwrite: true, folderUid: '' } });

    try {
      const responsePromise = page.waitForResponse((response) => response.url().includes('/api/ds/query'), {
        timeout: 60_000,
      });
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;

      const frames = await expectQuerySucceeded(response);
      expect(rowCount(frames[0]), 'the builder query must return the seeded buckets').toBeGreaterThan(0);
    } finally {
      await page.request.delete(`/api/dashboards/uid/${uid}`);
    }
  });
});
