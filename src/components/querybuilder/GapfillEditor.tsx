import React from 'react';
import { Button, InlineField, Input, Select, VerticalGroup } from '@grafana/ui';

import type { KwdbDataSource } from '../../datasource';
import { buildSql, coerceGapfillMetric, normalizeInterpolateMode } from '../../sqlBuilder';
import type { KwdbQuery, MetricSpec } from '../../types';
import { SqlPreview } from './SqlPreview';
import { ColumnPicker } from './shared/ColumnPicker';
import { IntervalPicker } from './shared/IntervalPicker';
import { MetricRow } from './shared/MetricRow';
import { tableChangePatch } from './shared/queryChanges';
import { TableSelector } from './shared/TableSelector';
import { TimeColumnPicker } from './shared/TimeColumnPicker';
import { useTableColumns } from './shared/useTableColumns';

const INTERPOLATE_MODES: Array<NonNullable<KwdbQuery['interpolateMode']>> = [
  'linear',
  'prev',
  'next',
  'null',
  'constant',
];

function parseConstantValue(raw: string): number | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

interface Props {
  datasource: KwdbDataSource;
  query: KwdbQuery;
  onChange: (query: KwdbQuery) => void;
}

export function GapfillEditor({ datasource, query, onChange }: Props) {
  const columns = useTableColumns(datasource, query.table);
  const interpolateMode = normalizeInterpolateMode(query.interpolateMode);

  // A query saved before "none" was excluded from the gapfill dropdown would
  // still carry it; interpolate() cannot take a bare column, so it is coerced
  // to the default aggregation instead of emitting a statement KWDB rejects.
  const metrics: MetricSpec[] = (
    query.metrics?.length ? query.metrics : [{ column: '', aggregation: 'avg' as const }]
  ).map(coerceGapfillMetric);

  const updateQuery = (patch: Partial<KwdbQuery>) => {
    // Rebuild the SQL from the coerced metrics, so editing the interval, the
    // tags or the interpolation mode also repairs a legacy `none` instead of
    // only editing the metric row doing so.
    const next: KwdbQuery = { ...query, metrics, ...patch };
    next.rawSql = buildSql(next);
    onChange(next);
  };

  const updateMetric = (index: number, metric: MetricSpec) => {
    updateQuery({ metrics: metrics.map((item, itemIndex) => (itemIndex === index ? metric : item)) });
  };

  const removeMetric = (index: number) => {
    if (metrics.length <= 1) {
      return;
    }
    updateQuery({ metrics: metrics.filter((_, itemIndex) => itemIndex !== index) });
  };

  return (
    <VerticalGroup spacing="md">
      <InlineField label="Table" labelWidth={12}>
        <TableSelector
          datasource={datasource}
          value={query.table}
          onChange={(table) => {
            const patch = tableChangePatch(table, query.table);
            if (patch) {
              updateQuery(patch);
            }
          }}
        />
      </InlineField>
      <InlineField label="Time column" labelWidth={12}>
        <TimeColumnPicker
          columns={columns}
          value={query.timeColumn}
          onChange={(timeColumn) => updateQuery({ timeColumn })}
        />
      </InlineField>
      <InlineField
        label="Interval"
        labelWidth={12}
        tooltip="Bucket size for time_bucket(). Fixed: a literal such as 15m. Variable: Auto ($__interval) adapts to each panel, while a dashboard variable such as ${interval} controls every panel from one place."
      >
        <IntervalPicker value={query.interval ?? '5m'} onChange={(interval) => updateQuery({ interval })} />
      </InlineField>
      <InlineField label="Interpolation" labelWidth={12}>
        <Select<NonNullable<KwdbQuery['interpolateMode']>>
          aria-label="Interpolation mode"
          options={INTERPOLATE_MODES.map((mode) => ({ label: mode, value: mode }))}
          value={interpolateMode}
          onChange={(item) => updateQuery({ interpolateMode: item.value ?? 'linear' })}
          width={20}
          menuShouldPortal={false}
        />
      </InlineField>
      {interpolateMode === 'constant' && (
        <InlineField label="Constant value" labelWidth={12} tooltip="Numeric value used for gaps. Defaults to 0.">
          <Input
            aria-label="Constant value"
            type="number"
            value={query.interpolateConstant ?? 0}
            onChange={(event) => updateQuery({ interpolateConstant: parseConstantValue(event.currentTarget.value) })}
            width={24}
          />
        </InlineField>
      )}
      <InlineField label="Tags" labelWidth={12}>
        <ColumnPicker columns={columns} value={query.tags ?? []} onChange={(tags) => updateQuery({ tags })} />
      </InlineField>
      <InlineField label="Metrics" labelWidth={12}>
        <VerticalGroup spacing="sm">
          {metrics.map((metric, index) => (
            <MetricRow
              key={index}
              index={index}
              columns={columns}
              metric={metric}
              onChange={(nextMetric) => updateMetric(index, nextMetric)}
              onRemove={metrics.length > 1 ? () => removeMetric(index) : undefined}
              // interpolate() requires an aggregate function, so a bare column
              // cannot be gap-filled: KWDB rejects it with "the first parameter
              // of interpolate must be agg func".
              excludeAggregations={['none']}
            />
          ))}
          <Button
            icon="plus-circle"
            variant="secondary"
            size="sm"
            onClick={() => updateQuery({ metrics: [...metrics, { column: '', aggregation: 'avg' }] })}
          >
            Add metric
          </Button>
        </VerticalGroup>
      </InlineField>
      <SqlPreview sql={query.rawSql ?? ''} />
    </VerticalGroup>
  );
}
