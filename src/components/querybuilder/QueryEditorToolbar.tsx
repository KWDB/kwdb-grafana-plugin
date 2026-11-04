import React from 'react';
import { InlineField, Input, Select, Stack } from '@grafana/ui';

import { buildSql } from '../../sqlBuilder';
import { TableSelector } from './shared/TableSelector';
import type { KwdbQuery, KwdbQueryFormat, KwdbQueryMode, MetricSpec } from '../../types';

const MODE_OPTIONS: Array<{ label: string; value: KwdbQueryMode }> = [
  { label: 'Downsampling', value: 'downsampling' },
  { label: 'Gapfill', value: 'gapfill' },
  { label: 'Latest Values', value: 'latest' },
  { label: 'Window/Event', value: 'window' },
  { label: 'Raw SQL', value: 'raw' },
];

const FORMAT_OPTIONS: Array<{ label: string; value: KwdbQueryFormat }> = [
  { label: 'Time series', value: 'time_series' },
  { label: 'Table', value: 'table' },
];

function defaultMetric(): MetricSpec {
  return { column: '', aggregation: 'avg' };
}

function defaultsForMode(query: KwdbQuery, mode: KwdbQueryMode): Partial<KwdbQuery> {
  const metrics = query.metrics?.length ? query.metrics : [defaultMetric()];
  switch (mode) {
    case 'gapfill':
      return {
        mode,
        format: query.format ?? 'time_series',
        interval: query.interval ?? '5m',
        interpolateMode: query.interpolateMode ?? 'linear',
        metrics,
      };
    case 'latest':
      return {
        mode,
        format: query.format ?? 'time_series',
        latestFunc: query.latestFunc ?? 'last',
        metrics: query.metrics?.length ? query.metrics : [{ column: '', aggregation: 'none' }],
      };
    case 'window':
      return {
        mode,
        format: query.format ?? 'time_series',
        windowType: query.windowType ?? 'TIME_WINDOW',
        windowInterval: query.windowInterval ?? '1h',
        metrics,
      };
    case 'raw':
      return { mode };
    case 'downsampling':
    default:
      return {
        mode,
        format: query.format ?? 'time_series',
        interval: query.interval ?? '5m',
        metrics,
      };
  }
}

interface Props {
  query: KwdbQuery;
  onChange: (query: KwdbQuery) => void;
  datasource?: import('../../datasource').KwdbDataSource;
}

export function QueryEditorToolbar({ query, onChange, datasource }: Props) {
  const onModeChange = (mode: KwdbQueryMode) => {
    const next = { ...query, ...defaultsForMode(query, mode) };
    if (mode === 'raw') {
      // Prefer the SQL the user wrote by hand over whatever the builder last produced.
      next.rawSql = query.customRawSql ?? query.rawSql ?? '';
    } else {
      // Keep the builder preview in sync without touching the saved custom SQL.
      next.rawSql = buildSql(next);
    }
    onChange(next);
  };

  const onFormatChange = (format: KwdbQueryFormat) => {
    onChange({ ...query, format });
  };

  return (
    <Stack gap={2}>
      <InlineField label="Mode" labelWidth={10}>
        <Select<KwdbQueryMode>
          aria-label="Mode"
          options={MODE_OPTIONS}
          value={query.mode ?? 'downsampling'}
          onChange={(item) => onModeChange(item.value ?? 'downsampling')}
          width={24}
          menuShouldPortal={false}
        />
      </InlineField>
      <InlineField
        label="Format"
        labelWidth={10}
        tooltip="Time series: one series per tag value (best for chart panels like Time series, Stat, Gauge). Table: raw rows (best for the Table panel)."
      >
        <Select<KwdbQueryFormat>
          aria-label="Format"
          options={FORMAT_OPTIONS}
          value={query.format ?? 'time_series'}
          onChange={(item) => onFormatChange(item.value ?? 'time_series')}
          width={20}
          menuShouldPortal={false}
        />
      </InlineField>
      <InlineField
        label="Ad Hoc table"
        labelWidth={13}
        tooltip="Table used to suggest keys and values for dashboard Ad Hoc filters. Builder queries default to their selected table."
      >
        {datasource ? (
          <TableSelector
            datasource={datasource}
            value={query.adHocTable ?? query.table}
            onChange={(adHocTable) => onChange({ ...query, adHocTable })}
            ariaLabel="Ad Hoc table"
            placeholder="Use query table"
          />
        ) : (
          <Input
            aria-label="Ad Hoc table"
            value={query.adHocTable ?? ''}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
              onChange({ ...query, adHocTable: event.currentTarget.value })
            }
            width={40}
          />
        )}
      </InlineField>
    </Stack>
  );
}
