import React from 'react';
import { QueryEditorProps } from '@grafana/data';

import type { KwdbDataSource } from '../datasource';
import type { KwdbDataSourceOptions, KwdbQuery } from '../types';
import { DownsamplingEditor } from './querybuilder/DownsamplingEditor';
import { GapfillEditor } from './querybuilder/GapfillEditor';
import { LatestValueEditor } from './querybuilder/LatestValueEditor';
import { QueryEditorToolbar } from './querybuilder/QueryEditorToolbar';
import { RawSqlEditor } from './querybuilder/RawSqlEditor';
import { WindowEventEditor } from './querybuilder/WindowEventEditor';

type Props = QueryEditorProps<KwdbDataSource, KwdbQuery, KwdbDataSourceOptions>;

export function QueryEditor({ datasource, query, onChange, onRunQuery }: Props) {
  const mode = query.mode ?? 'downsampling';

  let editor: React.ReactNode;
  switch (mode) {
    case 'gapfill':
      editor = <GapfillEditor datasource={datasource} query={query} onChange={onChange} />;
      break;
    case 'latest':
      editor = <LatestValueEditor datasource={datasource} query={query} onChange={onChange} />;
      break;
    case 'window':
      editor = <WindowEventEditor datasource={datasource} query={query} onChange={onChange} />;
      break;
    case 'raw':
      editor = <RawSqlEditor query={query} onChange={onChange} />;
      break;
    case 'downsampling':
    default:
      editor = <DownsamplingEditor datasource={datasource} query={query} onChange={onChange} />;
      break;
  }

  return (
    <div>
      <QueryEditorToolbar datasource={datasource} query={query} onChange={onChange} />
      {editor}
    </div>
  );
}
