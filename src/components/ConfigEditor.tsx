import React, { ChangeEvent } from 'react';
import { InlineField, InlineFieldRow, Input, SecretInput, Select, VerticalGroup } from '@grafana/ui';
import { DataSourcePluginOptionsEditorProps } from '@grafana/data';

import { KwdbDataSourceOptions, KwdbSecureJsonData } from '../types';

type Props = DataSourcePluginOptionsEditorProps<KwdbDataSourceOptions, KwdbSecureJsonData>;

type NumericJsonDataField =
  | 'maxConns'
  | 'maxConnLifetime'
  | 'maxConnIdleTime'
  | 'connectTimeout'
  | 'queryTimeout'
  | 'maxRows';

const SSL_MODE_OPTIONS: Array<{ label: string; value: NonNullable<KwdbDataSourceOptions['sslMode']> }> = [
  { label: 'disable', value: 'disable' },
  { label: 'require', value: 'require' },
  { label: 'verify-ca', value: 'verify-ca' },
  { label: 'verify-full', value: 'verify-full' },
];

export function ConfigEditor(props: Props) {
  const { onOptionsChange, options } = props;
  const { jsonData, secureJsonFields, secureJsonData } = options;

  const updateJsonData = (patch: Partial<KwdbDataSourceOptions>) => {
    onOptionsChange({
      ...options,
      jsonData: {
        ...jsonData,
        ...patch,
      },
    });
  };

  const onHostChange = (event: ChangeEvent<HTMLInputElement>) => {
    updateJsonData({ host: event.target.value });
  };

  const onPortChange = (event: ChangeEvent<HTMLInputElement>) => {
    const port = Number.parseInt(event.target.value, 10);
    updateJsonData({ port: Number.isNaN(port) ? undefined : port });
  };

  const onDatabaseChange = (event: ChangeEvent<HTMLInputElement>) => {
    updateJsonData({ database: event.target.value });
  };

  const onUserChange = (event: ChangeEvent<HTMLInputElement>) => {
    updateJsonData({ user: event.target.value });
  };

  const onSslModeChange = (sslMode: KwdbDataSourceOptions['sslMode']) => {
    updateJsonData({ sslMode: sslMode ?? 'disable' });
  };

  const onSslRootCertChange = (event: ChangeEvent<HTMLInputElement>) => {
    updateJsonData({ sslRootCert: event.target.value });
  };

  const onNumericChange = (field: NumericJsonDataField) => (event: ChangeEvent<HTMLInputElement>) => {
    const value = event.target.value;
    const parsed = Number(value);
    updateJsonData({
      [field]: value === '' || Number.isNaN(parsed) ? undefined : parsed,
    } as Partial<KwdbDataSourceOptions>);
  };

  const onPasswordChange = (event: ChangeEvent<HTMLInputElement>) => {
    onOptionsChange({
      ...options,
      secureJsonData: {
        ...secureJsonData,
        password: event.target.value,
      },
    });
  };

  const onResetPassword = () => {
    onOptionsChange({
      ...options,
      secureJsonFields: {
        ...secureJsonFields,
        password: false,
      },
      secureJsonData: {
        ...secureJsonData,
        password: '',
      },
    });
  };

  return (
    <VerticalGroup spacing="md">
      <InlineField label="Host" labelWidth={14}>
        <Input
          id="config-editor-host"
          onChange={onHostChange}
          value={jsonData.host ?? ''}
          placeholder="localhost"
          width={40}
        />
      </InlineField>
      <InlineField label="Port" labelWidth={14}>
        <Input
          id="config-editor-port"
          onChange={onPortChange}
          value={jsonData.port ?? 26257}
          type="number"
          placeholder="26257"
          width={40}
        />
      </InlineField>
      <InlineField label="Database" labelWidth={14}>
        <Input
          id="config-editor-database"
          onChange={onDatabaseChange}
          value={jsonData.database ?? ''}
          placeholder="defaultdb"
          width={40}
        />
      </InlineField>
      <InlineField label="User" labelWidth={14}>
        <Input id="config-editor-user" onChange={onUserChange} value={jsonData.user ?? ''} placeholder="root" width={40} />
      </InlineField>
      <InlineField label="SSL Mode" labelWidth={14}>
        <Select<'disable' | 'require' | 'verify-ca' | 'verify-full'>
          aria-label="SSL Mode"
          options={SSL_MODE_OPTIONS}
          value={jsonData.sslMode ?? 'disable'}
          onChange={(item) => onSslModeChange(item.value)}
          width={40}
          menuShouldPortal={false}
        />
      </InlineField>
      <InlineField label="SSL Root Cert" labelWidth={14}>
        <Input
          id="config-editor-ssl-root-cert"
          onChange={onSslRootCertChange}
          value={jsonData.sslRootCert ?? ''}
          placeholder="/path/to/ca.crt"
          width={40}
        />
      </InlineField>
      <InlineField label="Password" labelWidth={14}>
        <SecretInput
          id="config-editor-password"
          isConfigured={Boolean(secureJsonFields?.password)}
          value={secureJsonData?.password ?? ''}
          placeholder="Password"
          width={40}
          onReset={onResetPassword}
          onChange={onPasswordChange}
        />
      </InlineField>
      {/*
        Pool and timeout settings. Every field in a row uses the same labelWidth
        so the two columns line up; mixing 16 and 18 pushed the right column's
        input out of line and made long labels wrap.
      */}
      <InlineFieldRow>
        <InlineField
          label="Max connections"
          labelWidth={21}
          tooltip="Maximum number of database connections in the pool (default: 8)"
        >
          <Input
            id="config-editor-max-conns"
            type="number"
            value={jsonData.maxConns ?? ''}
            onChange={onNumericChange('maxConns')}
            placeholder="8"
            width={12}
          />
        </InlineField>
        <InlineField label="Connect timeout (s)" labelWidth={21} tooltip="Connection timeout in seconds (default: 5)">
          <Input
            id="config-editor-connect-timeout"
            type="number"
            value={jsonData.connectTimeout ?? ''}
            onChange={onNumericChange('connectTimeout')}
            placeholder="5"
            width={12}
          />
        </InlineField>
      </InlineFieldRow>
      <InlineFieldRow>
        <InlineField
          label="Query timeout (s)"
          labelWidth={21}
          tooltip="Per-statement timeout in seconds, enforced as statement_timeout and a query deadline (default: 30, -1 disables)"
        >
          <Input
            id="config-editor-query-timeout"
            type="number"
            value={jsonData.queryTimeout ?? ''}
            onChange={onNumericChange('queryTimeout')}
            placeholder="30"
            width={12}
          />
        </InlineField>
        <InlineField
          label="Max rows"
          labelWidth={21}
          tooltip="Rows buffered per frame before the query is cancelled (default: 100000, -1 disables)"
        >
          <Input
            id="config-editor-max-rows"
            type="number"
            value={jsonData.maxRows ?? ''}
            onChange={onNumericChange('maxRows')}
            placeholder="100000"
            width={12}
          />
        </InlineField>
      </InlineFieldRow>
      <InlineFieldRow>
        <InlineField
          label="Max lifetime (s)"
          labelWidth={21}
          tooltip="Maximum connection lifetime in seconds (default: 3600)"
        >
          <Input
            id="config-editor-max-conn-lifetime"
            type="number"
            value={jsonData.maxConnLifetime ?? ''}
            onChange={onNumericChange('maxConnLifetime')}
            placeholder="3600"
            width={12}
          />
        </InlineField>
        <InlineField label="Max idle time (s)" labelWidth={21} tooltip="Maximum idle time in seconds (default: 900)">
          <Input
            id="config-editor-max-conn-idle-time"
            type="number"
            value={jsonData.maxConnIdleTime ?? ''}
            onChange={onNumericChange('maxConnIdleTime')}
            placeholder="900"
            width={12}
          />
        </InlineField>
      </InlineFieldRow>
    </VerticalGroup>
  );
}
