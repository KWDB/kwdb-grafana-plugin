import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import { selectMetric, selectTable, selectTimeColumn, setMode, skipIfTableUnavailable } from './helpers';

// The interval control is a Fixed/Variable toggle. Variable mode offers the
// built-ins and the dashboard's own variables; these specs pin the behaviour
// down so a regression in label, seeding or visibility is caught.

function intervalSelect(page: import('@playwright/test').Page) {
  return page.getByRole('combobox', { name: 'Interval', exact: true });
}

function intervalLabel(page: import('@playwright/test').Page) {
  return intervalSelect(page).locator('xpath=ancestor::div[contains(@class,"select")][1]').innerText();
}

function sqlPreview(page: import('@playwright/test').Page) {
  return page.getByTestId('sql-preview').getByRole('textbox').inputValue();
}

test.describe('builder interval mode', () => {
  test.describe.configure({ timeout: 120_000 });

  test('switching to Variable seeds Auto and previews the token', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    // This panel editor belongs to a dashboard without variables, so the picker
    // has only the built-ins and must fall back to Auto rather than seeding a
    // ${interval} token that does not resolve.
    const source = page.getByRole('radiogroup', { name: 'Interval source' });
    await expect(source).toBeVisible();
    await page.getByRole('radio', { name: 'Variable' }).click();

    await expect.poll(() => intervalLabel(page)).toContain('Auto ($__interval)');
    await expect.poll(() => sqlPreview(page)).toContain('$__interval');
    expect(await sqlPreview(page)).not.toContain('${interval}');
  });

  test('Variable mode lists the built-ins and the dashboard variables', async ({ readProvisionedDataSource, page }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    const uid = `kwdb-interval-mode-${Date.now()}`;
    const body = {
      title: `KWDB interval mode ${uid}`,
      uid,
      schemaVersion: 39,
      editable: true,
      time: { from: e2eConfig.from, to: e2eConfig.to },
      templating: {
        list: [
          {
            name: 'interval',
            label: 'Bucket',
            type: 'custom',
            query: '5m,15m,1h',
            current: { text: '15m', value: '15m', selected: true },
            options: [
              { text: '5m', value: '5m' },
              { text: '15m', value: '15m', selected: true },
              { text: '1h', value: '1h' },
            ],
            hide: 0,
            multi: false,
            includeAll: false,
          },
        ],
      },
      panels: [
        {
          id: 1,
          title: 'builder',
          type: 'timeseries',
          gridPos: { h: 8, w: 24, x: 0, y: 0 },
          datasource: { type: ds.type, uid: ds.uid },
          targets: [
            {
              refId: 'A',
              datasource: { type: ds.type, uid: ds.uid },
              mode: 'downsampling',
              format: 'time_series',
              table: e2eConfig.table,
              timeColumn: e2eConfig.timeColumn,
              interval: '${interval}',
              tags: [e2eConfig.tagColumn],
              metrics: [{ column: e2eConfig.metric, aggregation: 'avg' }],
              rawSql: '',
            },
          ],
        },
      ],
    };
    const saved = await page.request.post('/api/dashboards/db', {
      data: { dashboard: body, overwrite: true, folderUid: '' },
    });
    expect(saved.ok(), `saving dashboard returned ${saved.status()}`).toBeTruthy();

    try {
      await page.goto(`/d/${uid}?orgId=1&editPanel=1`);
      await page.waitForLoadState('networkidle');

      // The saved query already points at ${interval}, so the picker opens in
      // Variable mode and shows that dashboard variable.
      await expect.poll(() => intervalLabel(page)).toContain('${interval}');

      await intervalSelect(page).click();
      const options = page.getByRole('option');
      await expect(options.filter({ hasText: 'Auto ($__interval)' })).toHaveCount(1);
      await expect(options.filter({ hasText: 'Auto, ms ($__interval_ms)' })).toHaveCount(1);
      await expect(options.filter({ hasText: '${interval}' })).toHaveCount(1);
      await page.keyboard.press('Escape');
    } finally {
      await page.request.delete(`/api/dashboards/uid/${uid}`);
    }
  });

  test('the Ad Hoc table field only appears in Raw SQL mode', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    const adHocTable = page.getByRole('combobox', { name: 'Ad Hoc table', exact: true });
    // Builder targets name their table already, so the field is not shown.
    await expect(adHocTable).toHaveCount(0);

    await setMode(page, 'Raw SQL');
    await expect(adHocTable).toHaveCount(1);

    await setMode(page, 'Downsampling');
    await expect(adHocTable).toHaveCount(0);
  });
});
