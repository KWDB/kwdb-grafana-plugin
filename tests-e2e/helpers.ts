import { expect, test } from '@grafana/plugin-e2e';
import type { PanelEditPage } from '@grafana/plugin-e2e';
import type { Page } from '@playwright/test';

import { e2eConfig, INTERVAL_PRESETS } from './config';

// Minimal shapes of the Grafana /api/ds/query response used by the assertions below.
export interface FrameField {
  name: string;
  type?: string;
  labels?: Record<string, string> | null;
}

export interface DataFrame {
  schema?: { name?: string; fields?: FrameField[] };
  data?: { values?: unknown[][] };
}

export interface QueryResult {
  // Grafana reports a numeric HTTP-like status (200 on success) in the response body.
  // Older versions / streaming payloads may report 'finished' instead, so both are accepted.
  status?: number | string;
  error?: string;
  errorSource?: string;
  frames?: DataFrame[];
}

interface TableResourceItem {
  name?: string;
  type?: string;
}

/**
 * Minimal shape shared by Playwright's `Response` (panel refresh) and `APIResponse`
 * (`page.request.post`), so the same assertions can be used for both.
 */
interface JsonResponse {
  json(): Promise<unknown>;
}

/**
 * Skips the current test (rather than failing or passing) when the configured table is not
 * available in the provisioned data source. This keeps the default `demo_ts.sensors` suite
 * runnable in CI while allowing the same specs to run against arbitrary KWDB databases.
 */
export async function skipIfTableUnavailable(page: Page, datasourceUid: string): Promise<void> {
  await skipUnlessTable(
    page,
    datasourceUid,
    e2eConfig.tableShortName,
    `Table ${e2eConfig.table} was not found in datasource ${datasourceUid}. ` +
      'Set KWDB_E2E_TABLE (plus KWDB_E2E_TIME_COLUMN/KWDB_E2E_COLUMNS/KWDB_E2E_TAG_COLUMN/KWDB_E2E_METRIC) ' +
      'to run these tests against an existing KWDB table.'
  );
}

/**
 * Skips the current test when the adversarial `edge_cases` table seeded by scripts/init.sql
 * is missing. Pointing the suite at another database stays possible; those specs simply skip
 * instead of failing on data they do not own.
 */
export async function skipIfEdgeTableUnavailable(page: Page, datasourceUid: string): Promise<void> {
  await skipUnlessTable(
    page,
    datasourceUid,
    e2eConfig.edgeTableShortName,
    `Table ${e2eConfig.edgeTable} was not found in datasource ${datasourceUid}. ` +
      'It is created by scripts/init.sql; set KWDB_E2E_EDGE_TABLE to override its name.'
  );
}

async function skipUnlessTable(page: Page, datasourceUid: string, shortName: string, reason: string): Promise<void> {
  const response = await page.request.get(`/api/datasources/uid/${encodeURIComponent(datasourceUid)}/resources/tables`);
  expect(response.ok(), `GET /resources/tables returned HTTP ${response.status()}`).toBeTruthy();

  const tables = (await response.json()) as TableResourceItem[];
  expect(Array.isArray(tables), 'expected /resources/tables to return an array').toBeTruthy();

  const found = tables.some((table) => (table.name ?? '').toLowerCase() === shortName.toLowerCase());
  if (!found) {
    test.skip(true, reason);
  }
}

export async function readQueryResult(response: JsonResponse): Promise<QueryResult> {
  const body = (await response.json()) as { results?: Record<string, QueryResult> };
  const results = body?.results ?? {};
  const refIds = Object.keys(results);
  expect(refIds.length, 'query response did not contain any results').toBeGreaterThan(0);
  const refId = refIds.includes('A') ? 'A' : refIds[0];
  return results[refId];
}

/** Asserts the query finished without a backend error and returned at least one frame. */
export async function expectQuerySucceeded(response: JsonResponse): Promise<DataFrame[]> {
  const result = await readQueryResult(response);
  expect(result.error, `query returned an error: ${result.error ?? ''}`).toBeUndefined();
  expect([200, 'finished'], `unexpected query status ${String(result.status)}`).toContain(result.status);
  const frames = result.frames ?? [];
  expect(frames.length, 'query returned no frames').toBeGreaterThan(0);
  return frames;
}

/** Asserts the backend rejected the query (used for the read-only guard). */
export async function expectQueryRejected(response: JsonResponse): Promise<QueryResult> {
  const result = await readQueryResult(response);
  expect(result.error, 'expected the backend to reject the query, but no error was returned').toBeTruthy();
  expect(result.errorSource).toBe('plugin');
  expect([400, 500], `unexpected rejection status ${String(result.status)}`).toContain(result.status);
  expect(result.frames ?? []).toHaveLength(0);
  return result;
}

export function fieldNames(frame: DataFrame): string[] {
  return (frame.schema?.fields ?? []).map((field) => field.name);
}

export function rowCount(frame: DataFrame): number {
  return frame.data?.values?.[0]?.length ?? 0;
}

export function labelledFields(frame: DataFrame): FrameField[] {
  return (frame.schema?.fields ?? []).filter((field) => {
    const labels = field.labels ?? {};
    return Object.keys(labels).length > 0;
  });
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Waits until the read-only SQL preview contains the expected fragment of the generated
 * statement.
 *
 * The preview is a monaco editor whose input textarea mirrors the whole statement (newlines
 * included), so the text is read from there instead of the `.view-line` elements monaco
 * virtualises while the editor re-renders. Monaco syncs that textarea asynchronously, so the
 * read is retried until the builder has produced the statement.
 */
export async function expectSqlPreviewContains(page: Page, expected: string, message: string): Promise<void> {
  const editor = page.getByTestId('sql-preview').getByRole('textbox');
  await expect(editor, 'the SQL preview did not render an editor').toBeAttached();

  const deadline = Date.now() + 15_000;
  let sql = '';
  while (Date.now() < deadline) {
    sql = (await editor.inputValue().catch(() => '')).replace(/\s+/g, ' ').trim();
    if (sql.includes(expected)) {
      return;
    }
    await page.waitForTimeout(250);
  }

  expect(sql, message).toContain(expected);
}

/**
 * Selects an option from a Grafana Select.
 *
 * Some pickers (e.g. the metric column picker) append the column type to the visible label,
 * so the accessible option name becomes `current_val FLOAT8`. Callers may pass a RegExp for
 * those cases. The retry loop tolerates options that are populated asynchronously (e.g. after
 * the /columns resource response).
 *
 * Exported so specs that drive dropdowns which only exist in a single editor mode (the
 * latest-function and tags pickers, the window parameters) do not need a private copy.
 */
export async function pickOption(page: Page, comboboxName: string, optionName: string | RegExp): Promise<void> {
  // Match the accessible name exactly: the editor also has an "Ad Hoc table"
  // picker, and a loose match for "Table" would resolve to both comboboxes.
  const combobox = page.getByRole('combobox', { name: comboboxName, exact: true });
  const option =
    typeof optionName === 'string'
      ? page.getByRole('option', { name: optionName, exact: true })
      : page.getByRole('option', { name: optionName });

  for (let attempt = 0; attempt < 5; attempt++) {
    await combobox.click();
    try {
      await option.waitFor({ state: 'visible', timeout: 3000 });
      await option.click();
      return;
    } catch {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  }

  throw new Error(`Could not select option ${String(optionName)} in the "${comboboxName}" dropdown`);
}

export async function setMode(
  page: Page,
  mode: 'Downsampling' | 'Gapfill' | 'Latest Values' | 'Window/Event' | 'Raw SQL'
) {
  await pickOption(page, 'Mode', mode);
}

export async function setFormat(page: Page, format: 'Time series' | 'Table'): Promise<void> {
  await pickOption(page, 'Format', format);
}

/** Selects the configured table and waits until its columns have been loaded. */
export async function selectTable(page: Page): Promise<void> {
  // Grafana routes plugin resources through `/resources/<path>`, and the plugin requests
  // `/columns`, which results in `/resources//columns?table=...` in the browser URL.
  const columnsLoaded = page.waitForResponse((response) => response.url().includes('columns?table='));
  await pickOption(page, 'Table', e2eConfig.tableOptionLabel);
  await columnsLoaded;
}

export async function selectTimeColumn(page: Page): Promise<void> {
  await pickOption(page, 'Time column', e2eConfig.timeColumn);
}

export async function selectMetric(page: Page): Promise<void> {
  // The metric picker renders the column type as a description, e.g. "current_val FLOAT8".
  await pickOption(page, 'Metric column 0', new RegExp(`^${escapeRegExp(e2eConfig.metric)}(?:\\s|$)`));
}

/** Selects the configured interval when it is one of the presets exposed by the picker. */
export async function selectIntervalWhenPreset(page: Page): Promise<void> {
  if (INTERVAL_PRESETS.includes(e2eConfig.interval)) {
    await pickOption(page, 'Interval', e2eConfig.interval);
  }
}

export async function setRawSql(page: Page, sql: string): Promise<void> {
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type(sql);
}

export async function setQueryTimeRange(
  panelEditPage: PanelEditPage,
  range: { from: string; to: string } = { from: e2eConfig.from, to: e2eConfig.to }
): Promise<void> {
  await panelEditPage.timeRange.set(range);
}
