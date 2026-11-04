import { expect, test } from '@grafana/plugin-e2e';

import { e2eConfig } from './config';
import {
  escapeRegExp,
  expectQuerySucceeded,
  expectSqlPreviewContains,
  fieldNames,
  labelledFields,
  pickOption,
  rowCount,
  selectMetric,
  selectTable,
  selectTimeColumn,
  setMode,
  setQueryTimeRange,
  skipIfTableUnavailable,
} from './helpers';

test.describe('latest values query builder', () => {
  // Panel editor setup (time range picker + several async dropdowns) exceeds the 30s default
  // timeout on slower Grafana instances; the assertions themselves are fast.
  test.describe.configure({ timeout: 120_000 });

  test('latest values mode builds a last() query and returns the newest row', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await setQueryTimeRange(panelEditPage);

    await setMode(page, 'Latest Values');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    await expectSqlPreviewContains(
      page,
      `last("${e2eConfig.metric}")`,
      'latest values mode must aggregate the metric with last()'
    );
    await expectSqlPreviewContains(
      page,
      `last("${e2eConfig.timeColumn}") AS "time"`,
      'latest values mode must return the newest timestamp as "time"'
    );
    await expectSqlPreviewContains(
      page,
      `"${e2eConfig.timeColumn}" >= $__timeFrom`,
      'latest values mode must restrict the query to the panel time range'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(frames.length, 'latest values must return at least one frame').toBeGreaterThan(0);
    const frame = frames[0];
    const names = fieldNames(frame);

    expect(names, 'latest values must return a time field').toContain('time');
    expect(
      names.some((name) => name.startsWith('latest_')),
      `expected a last_<column> field for ${e2eConfig.metric}, got ${names.join(', ')}`
    ).toBeTruthy();
    expect(rowCount(frame), 'latest values returned no rows for the configured time range').toBeGreaterThan(0);
  });

  test('switching the latest function regenerates the SQL preview', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await setQueryTimeRange(panelEditPage);

    await setMode(page, 'Latest Values');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    // `first_row` is the mirrored "oldest value" function: the metric uses first_row() while
    // the timestamp falls back to first().
    await pickOption(page, 'Latest function', 'first_row');

    await expectSqlPreviewContains(
      page,
      `first_row("${e2eConfig.metric}")`,
      'selecting first_row must aggregate the metric with first_row()'
    );
    await expectSqlPreviewContains(
      page,
      `first("${e2eConfig.timeColumn}") AS "time"`,
      'selecting first_row must return the oldest timestamp as "time"'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    expect(fieldNames(frames[0]), 'the first_row query must still return a time field').toContain('time');
    expect(rowCount(frames[0]), 'the first_row query returned no rows').toBeGreaterThan(0);
  });

  test('an empty latest range renders no data instead of a plugin error', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    // 1990 predates every supported demo dataset, so the ungrouped aggregate below
    // returns its single all-NULL row instead of a real latest value.
    await setQueryTimeRange(panelEditPage, { from: '1990-01-01 00:00:00', to: '1990-01-02 00:00:00' });

    await setMode(page, 'Latest Values');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);
    expect(rowCount(frames[0]), 'an empty latest range must return zero rows').toBe(0);
  });

  test('an empty grouped latest range returns no frames instead of an error', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    // Grouping changes the database result shape: zero input rows produce zero
    // grouped rows rather than the single all-NULL row covered above.
    await setQueryTimeRange(panelEditPage, { from: '1990-01-01 00:00:00', to: '1990-01-02 00:00:00' });

    await setMode(page, 'Latest Values');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);
    await pickOption(page, 'Tags', new RegExp(`^${escapeRegExp(e2eConfig.tagColumn)}\\s*\\(tag\\)`));

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);
    expect(
      frames.every((frame) => rowCount(frame) === 0),
      'no group may carry data'
    ).toBeTruthy();
  });

  test('selecting a tag groups the latest value per tag', async ({
    readProvisionedDataSource,
    page,
    panelEditPage,
  }) => {
    const ds = await readProvisionedDataSource({ fileName: 'datasources.yml' });
    await skipIfTableUnavailable(page, ds.uid);

    await panelEditPage.datasource.set(ds.name);
    await panelEditPage.setVisualization('Table');
    await setQueryTimeRange(panelEditPage);

    await setMode(page, 'Latest Values');
    await selectTable(page);
    await selectTimeColumn(page);
    await selectMetric(page);

    // The tags picker is a multi select whose options are labelled "<column> (tag)" and carry the
    // column type as a description, so the option is matched by prefix.
    await pickOption(page, 'Tags', new RegExp(`^${escapeRegExp(e2eConfig.tagColumn)}\\s*\\(tag\\)`));

    await expectSqlPreviewContains(
      page,
      `GROUP BY "${e2eConfig.tagColumn}"`,
      'selecting a tag must add a GROUP BY clause for that tag'
    );
    await expectSqlPreviewContains(
      page,
      `"${e2eConfig.tagColumn}",`,
      'the tag column must be selected alongside the latest value'
    );

    const response = await panelEditPage.refreshPanel();
    const frames = await expectQuerySucceeded(response);

    const labelled = labelledFields(frames[0]);
    expect(
      labelled.length,
      `expected one latest value series per ${e2eConfig.tagColumn}, got ${labelled.length} labelled fields`
    ).toBeGreaterThan(0);
    for (const field of labelled) {
      expect(
        field.labels?.[e2eConfig.tagColumn],
        `series ${field.name} is missing its ${e2eConfig.tagColumn} label`
      ).toBeTruthy();
    }
  });
});
