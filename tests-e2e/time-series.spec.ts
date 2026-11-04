import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import { expectQuerySucceeded, fieldNames, labelledFields, rowCount, skipIfTableUnavailable } from './helpers';

test('raw SQL time_series format returns a wide frame with tag labels', async ({ readProvisionedDataSource, page }) => {
  const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
  await skipIfTableUnavailable(page, ds.uid);

  const now = Date.now();
  const from = String(now - 30 * 24 * 60 * 60 * 1000);

  const response = await page.request.post('/api/ds/query', {
    data: {
      queries: [
        {
          refId: 'A',
          datasource: { type: ds.type, uid: ds.uid },
          rawSql: `SELECT ${e2eConfig.timeColumn}, ${e2eConfig.tagColumn}, ${e2eConfig.metric} FROM ${e2eConfig.table} ORDER BY ${e2eConfig.timeColumn} LIMIT 100`,
          format: 'time_series',
          mode: 'raw',
          timeColumn: e2eConfig.timeColumn,
          tags: [e2eConfig.tagColumn],
        },
      ],
      from,
      to: String(now),
      intervalMs: 60000,
    },
  });

  expect(response.ok(), `POST /api/ds/query returned HTTP ${response.status()}`).toBeTruthy();

  const frames = await expectQuerySucceeded(response);
  expect(frames).toHaveLength(1);

  const frame = frames[0];
  const names = fieldNames(frame);
  expect(names[0], 'time_series frames must place the time field first').toBe('time');
  expect(names.length, 'expected the time field plus at least one value field').toBeGreaterThanOrEqual(2);
  expect(rowCount(frame), 'expected time_series to return at least one row').toBeGreaterThan(0);

  const labelled = labelledFields(frame);
  expect(labelled.length, `expected series labelled by ${e2eConfig.tagColumn}`).toBeGreaterThan(0);
  for (const field of labelled) {
    expect(
      field.labels?.[e2eConfig.tagColumn],
      `series ${field.name} has no ${e2eConfig.tagColumn} label`
    ).toBeTruthy();
  }
});
