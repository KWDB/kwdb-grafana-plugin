import React from 'react';
import { Button, InlineField, VerticalGroup } from '@grafana/ui';

import type { KwdbDataSource } from '../../datasource';
import { buildSql } from '../../sqlBuilder';
import type { KwdbQuery, MetricSpec } from '../../types';
import { SqlPreview } from './SqlPreview';
import { ColumnPicker } from './shared/ColumnPicker';
import { IntervalPicker } from './shared/IntervalPicker';
import { MetricRow } from './shared/MetricRow';
import { tableChangePatch } from './shared/queryChanges';
import { TableSelector } from './shared/TableSelector';
import { TimeColumnPicker } from './shared/TimeColumnPicker';
import { useTableColumns } from './shared/useTableColumns';

interface Props {
  datasource: KwdbDataSource;
  query: KwdbQuery;
  onChange: (query: KwdbQuery) => void;
}

export function DownsamplingEditor({ datasource, query, onChange }: Props) {
  const columns = useTableColumns(datasource, query.table);

  const updateQuery = (patch: Partial<KwdbQuery>) => {
    const next = { ...query, ...patch };
    next.rawSql = buildSql(next);
    onChange(next);
  };

  const metrics: MetricSpec[] = query.metrics?.length ? query.metrics : [{ column: '', aggregation: 'avg' }];

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
