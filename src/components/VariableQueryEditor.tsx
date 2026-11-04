import React, { useEffect, useMemo, useState } from 'react';
import { InlineField, Select, VerticalGroup } from '@grafana/ui';

import type { KwdbDataSource } from '../datasource';
import { buildVariableQueryString, parseVariableQuery } from '../variableQuery';
import type { ColumnInfo, KwdbVariableQuery, TableInfo } from '../types';

interface Props {
  query: KwdbVariableQuery | string | null | undefined;
  datasource: KwdbDataSource;
  onChange: (query: KwdbVariableQuery, definition: string) => void;
}

const QUERY_TYPE_OPTIONS = [
  { label: 'Tag Values', value: 'tagValues' },
  { label: 'Tables', value: 'tables' },
  { label: 'Columns', value: 'columns' },
];

function initialQuery(query: Props['query']): KwdbVariableQuery {
  if (query && typeof query === 'object') {
    return query;
  }
  try {
    return parseVariableQuery(query);
  } catch {
    return { queryType: 'tagValues' };
  }
}

/**
 * Renders the definition string Grafana shows next to the variable. An
 * incomplete query has no renderable definition yet; that is not an error, so
 * it yields an empty string instead of throwing.
 */
function safeDefinition(query: KwdbVariableQuery): string {
  try {
    return buildVariableQueryString(query);
  } catch {
    return '';
  }
}

export function VariableQueryEditor({ query, datasource, onChange }: Props) {
  const [state, setState] = useState<KwdbVariableQuery>(() => initialQuery(query));
  const [tables, setTables] = useState<{ items: TableInfo[]; loading: boolean }>({ items: [], loading: true });
  const [columns, setColumns] = useState<{ table?: string; items: ColumnInfo[]; loading: boolean }>({
    items: [],
    loading: false,
  });

  useEffect(() => {
    let cancelled = false;
    datasource
      .getTables()
      .then((result) => {
        if (!cancelled) {
          setTables({ items: result ?? [], loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setTables({ items: [], loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [datasource]);

  useEffect(() => {
    let cancelled = false;
    if (state.table) {
      datasource
        .getColumns(state.table)
        .then((result) => {
          if (!cancelled) {
            setColumns({ table: state.table, items: result ?? [], loading: false });
          }
        })
        .catch(() => {
          if (!cancelled) {
            setColumns({ table: state.table, items: [], loading: false });
          }
        });
    }
    return () => {
      cancelled = true;
    };
  }, [datasource, state.table]);

  const update = (patch: Partial<KwdbVariableQuery>) => {
    // Reset dependent fields when the query type or table changes.
    const next: KwdbVariableQuery = { ...state, ...patch };
    if (patch.queryType && patch.queryType !== state.queryType) {
      next.table = undefined;
      next.column = undefined;
    } else if (patch.table && patch.table !== state.table) {
      next.column = undefined;
    }
    setState(next);
    // The editor is legitimately in an incomplete state while the user fills it
    // in (e.g. a table is selected but the tag column is not yet). Building the
    // definition string must never throw here: an exception thrown from a React
    // event handler skips `onChange`, so the change would never reach the
    // variable model and the panel would keep running the previous query.
    onChange(next, safeDefinition(next));
  };

  // Only tag columns can provide distinct values for tag_values(table, column).
  const tagOptions = useMemo(
    () => columns.items.filter((column) => column.isTag).map((column) => ({ label: column.name, value: column.name })),
    [columns.items]
  );

  return (
    <VerticalGroup>
      <InlineField label="Query type" labelWidth={14}>
        <Select
          aria-label="Variable query type"
          options={QUERY_TYPE_OPTIONS}
          value={state.queryType}
          onChange={(item) => item.value && update({ queryType: item.value as KwdbVariableQuery['queryType'] })}
          width={24}
        />
      </InlineField>
      {state.queryType !== 'tables' && (
        <InlineField label="Table" labelWidth={14}>
          <Select
            aria-label="Variable table"
            isLoading={tables.loading}
            options={tables.items.map((table) => ({ label: table.name, value: table.name }))}
            value={state.table ? { label: state.table, value: state.table } : undefined}
            onChange={(item) => update({ table: item?.value ?? undefined })}
            placeholder="Select table"
            isClearable
            menuShouldPortal={false}
            width={24}
          />
        </InlineField>
      )}
      {state.queryType === 'tagValues' && (
        <InlineField label="Tag column" labelWidth={14} tooltip="Only tag columns can provide distinct values">
          <Select
            aria-label="Variable tag column"
            isLoading={Boolean(state.table) && columns.loading}
            options={tagOptions}
            value={state.column ? { label: state.column, value: state.column } : undefined}
            onChange={(item) => update({ column: item?.value ?? undefined })}
            placeholder={state.table ? 'Select tag column' : 'Select a table first'}
            isClearable
            disabled={!state.table}
            menuShouldPortal={false}
            width={24}
          />
        </InlineField>
      )}
    </VerticalGroup>
  );
}
