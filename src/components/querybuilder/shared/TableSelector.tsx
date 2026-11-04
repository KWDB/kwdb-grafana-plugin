import React, { useEffect, useState } from 'react';
import { Select } from '@grafana/ui';

import type { KwdbDataSource } from '../../../datasource';
import type { TableInfo } from '../../../types';

interface Props {
  datasource: KwdbDataSource;
  value?: string;
  onChange: (table: string) => void;
  ariaLabel?: string;
  placeholder?: string;
}

export function TableSelector({
  datasource,
  value,
  onChange,
  ariaLabel = 'Table',
  placeholder = 'Select table',
}: Props) {
  const [state, setState] = useState<{ tables: TableInfo[]; loading: boolean }>({ tables: [], loading: true });

  useEffect(() => {
    let cancelled = false;
    datasource
      .getTables()
      .then((result) => {
        if (!cancelled) {
          setState({ tables: result ?? [], loading: false });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState({ tables: [], loading: false });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [datasource]);

  const options = state.tables.map((table) => ({
    label: table.type ? `${table.name} (${table.type})` : table.name,
    value: table.name,
  }));
  const selected = state.tables.find((table) => table.name === value);

  return (
    <Select<string>
      aria-label={ariaLabel}
      isLoading={state.loading}
      options={options}
      value={
        value
          ? { label: selected ? (selected.type ? `${selected.name} (${selected.type})` : selected.name) : value, value }
          : undefined
      }
      onChange={(item) => onChange(item?.value ?? '')}
      placeholder={placeholder}
      isClearable
      menuShouldPortal={false}
      width={40}
    />
  );
}
