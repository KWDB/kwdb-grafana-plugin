import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import { expectQuerySucceeded, rowCount, skipIfTableUnavailable } from './helpers';

// Ad Hoc filters are applied by the frontend data source instance; posting to
// /api/ds/query directly would bypass the behavior under test. These specs save
// a temporary dashboard and observe the real panel request instead.

interface DashboardVariable {
  [key: string]: unknown;
}

function textboxVariable(name: string, value: string): DashboardVariable {
  return {
    name,
    label: name,
    type: 'textbox',
    query: value,
    current: { text: value, value },
    options: [{ text: value, value, selected: true }],
  };
}

function dashboard(
  uid: string,
  variables: DashboardVariable[],
  rawSql: string,
  options: {
    mode?: 'raw' | 'downsampling' | 'latest';
    adHocTable?: string;
    target?: Record<string, unknown>;
  } = {}
) {
  return {
    title: `KWDB regression ${uid}`,
    uid,
    schemaVersion: 39,
    editable: true,
    time: { from: e2eConfig.from, to: e2eConfig.to },
    templating: { list: variables },
    panels: [
      {
        id: 1,
        title: 'Regression panel',
        type: 'table',
        gridPos: { h: 8, w: 24, x: 0, y: 0 },
        datasource: { type: 'kwdb-tsdb-datasource', uid: 'kwdb-tsdb' },
        targets: [
          {
            refId: 'A',
            datasource: { type: 'kwdb-tsdb-datasource', uid: 'kwdb-tsdb' },
            mode: options.mode ?? 'raw',
            format: 'table',
            rawSql,
            adHocTable: options.adHocTable,
            ...options.target,
          },
        ],
      },
    ],
  };
}

async function saveDashboard(page: import('@playwright/test').Page, body: ReturnType<typeof dashboard>) {
  const response = await page.request.post('/api/dashboards/db', {
    data: { dashboard: body, overwrite: true, folderUid: '' },
  });
  expect(response.ok(), `saving dashboard returned ${response.status()}`).toBeTruthy();
}

async function deleteDashboard(page: import('@playwright/test').Page, uid: string) {
  await page.request.delete(`/api/dashboards/uid/${uid}`);
}

function panelRequest(page: import('@playwright/test').Page, expectedFragment: string) {
  return page.waitForResponse(
    (response) =>
      response.url().includes('/api/ds/query') && (response.request().postData() ?? '').includes(expectedFragment),
    { timeout: 60_000 }
  );
}

test.describe('dashboard variables and Ad Hoc filters', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a textbox table variable is expanded before the KWDB request', async ({ page }) => {
    const uid = `kwdb-var-${Date.now()}`;
    const parts = e2eConfig.table.split('.');
    const database = parts.length > 1 ? parts.shift() : '';
    const tableName = parts.join('.');
    const tableExpression = database ? `${database}.$table_name` : '$table_name';

    await saveDashboard(
      page,
      dashboard(uid, [textboxVariable('table_name', tableName)], `SELECT * FROM ${tableExpression} LIMIT 3`)
    );

    try {
      const responsePromise = panelRequest(page, e2eConfig.table);
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;

      const frames = await expectQuerySucceeded(response);
      expect(rowCount(frames[0]), 'the expanded query returned no rows').toBeGreaterThan(0);

      const body = JSON.parse(response.request().postData() ?? '{}') as {
        queries?: Array<{ rawSql?: string }>;
      };
      expect(body.queries?.[0]?.rawSql).toContain(e2eConfig.table);
      expect(body.queries?.[0]?.rawSql).not.toContain('$table_name');
    } finally {
      await deleteDashboard(page, uid);
    }
  });

  test('an Ad Hoc filter is applied to an unfiltered SELECT', async ({ page, readProvisionedDataSource }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    const uid = `kwdb-adhoc-${Date.now()}`;
    const adHocVariable = {
      name: 'filter',
      type: 'adhoc',
      datasource: { type: ds.type, uid: ds.uid },
      filters: [{ key: e2eConfig.tagColumn, operator: '=', value: '1', origin: 'dashboard' }],
      baseFilters: [],
      defaultKeys: [],
    };
    await saveDashboard(
      page,
      dashboard(uid, [adHocVariable], `SELECT ${e2eConfig.columns.join(', ')} FROM ${e2eConfig.table} LIMIT 20`)
    );

    try {
      const responsePromise = panelRequest(page, e2eConfig.tagColumn);
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;

      const frames = await expectQuerySucceeded(response);
      expect(frames.length).toBeGreaterThan(0);
      const body = JSON.parse(response.request().postData() ?? '{}') as {
        queries?: Array<{ rawSql?: string }>;
      };
      expect(body.queries?.[0]?.rawSql).toContain(e2eConfig.tagColumn);
      expect(body.queries?.[0]?.rawSql).toContain('adhoc_filters');
    } finally {
      await deleteDashboard(page, uid);
    }
  });

  test('a builder Ad Hoc filter is applied before aggregation', async ({ page, readProvisionedDataSource }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    const uid = `kwdb-adhoc-builder-${Date.now()}`;
    const adHocVariable = {
      name: 'filter',
      type: 'adhoc',
      datasource: { type: ds.type, uid: ds.uid },
      filters: [{ key: e2eConfig.tagColumn, operator: '=', value: '1', origin: 'dashboard' }],
      baseFilters: [],
      defaultKeys: [],
    };
    await saveDashboard(
      page,
      dashboard(uid, [adHocVariable], '', {
        mode: 'downsampling',
        target: {
          table: e2eConfig.table,
          timeColumn: e2eConfig.timeColumn,
          interval: '1h',
          metrics: [{ column: e2eConfig.metric, aggregation: 'avg' }],
        },
      })
    );

    try {
      const responsePromise = panelRequest(page, e2eConfig.tagColumn);
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;

      await expectQuerySucceeded(response);
      const body = JSON.parse(response.request().postData() ?? '{}') as {
        queries?: Array<{ rawSql?: string }>;
      };
      const sql = body.queries?.[0]?.rawSql ?? '';
      expect(sql).toContain(e2eConfig.tagColumn);
      expect(sql).not.toContain('adhoc_filters');
      expect(sql.indexOf(e2eConfig.tagColumn)).toBeLessThan(sql.indexOf('GROUP BY'));
    } finally {
      await deleteDashboard(page, uid);
    }
  });

  test('a builder interval variable is expanded before the KWDB request', async ({ page }) => {
    const uid = `kwdb-builder-var-${Date.now()}`;
    await saveDashboard(
      page,
      dashboard(uid, [textboxVariable('bucket', '1h')], '', {
        mode: 'downsampling',
        target: {
          table: e2eConfig.table,
          timeColumn: e2eConfig.timeColumn,
          interval: '${bucket}',
          metrics: [{ column: e2eConfig.metric, aggregation: 'avg' }],
        },
      })
    );

    try {
      const responsePromise = panelRequest(page, `time_bucket`);
      await page.goto(`/d/${uid}?orgId=1&kiosk`);
      const response = await responsePromise;
      await expectQuerySucceeded(response);

      const body = JSON.parse(response.request().postData() ?? '{}') as {
        queries?: Array<{ rawSql?: string }>;
      };
      const sql = body.queries?.[0]?.rawSql ?? '';
      expect(sql).toContain('1h');
      expect(sql).not.toContain('$bucket');
    } finally {
      await deleteDashboard(page, uid);
    }
  });

  test('the Ad Hoc metadata resource is reachable with an explicit table', async ({
    page,
    readProvisionedDataSource,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    const keys = await page.request.get(
      `/api/datasources/uid/${encodeURIComponent(ds.uid)}/resources/tag-keys?table=${encodeURIComponent(
        e2eConfig.tableShortName
      )}`
    );
    expect(keys.ok(), `GET /tag-keys returned ${keys.status()}`).toBeTruthy();
    const values = await page.request.get(
      `/api/datasources/uid/${encodeURIComponent(ds.uid)}/resources/tag-values?table=${encodeURIComponent(
        e2eConfig.tableShortName
      )}&column=${encodeURIComponent(e2eConfig.tagColumn)}`
    );
    expect(values.ok(), `GET /tag-values returned ${values.status()}`).toBeTruthy();
  });
});
