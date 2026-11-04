import React from 'react';
import { RadioButtonGroup, Select, Stack } from '@grafana/ui';
import { getTemplateSrv } from '@grafana/runtime';

const PRESET_INTERVALS = ['1m', '5m', '15m', '1h', '6h', '1d'];

type IntervalMode = 'fixed' | 'variable';

const modeOf = (value: string): IntervalMode => (/\$/.test(value) ? 'variable' : 'fixed');

interface VariableOption {
  label: string;
  value: string;
  description?: string;
}

/**
 * Variables that can drive a bucket size.
 *
 * Built-ins come first because they need no dashboard setup. Every dashboard
 * variable is then offered by name, which is what makes the feature usable:
 * the previous control was a free-text box, so nothing on screen told the user
 * that `${interval}` was even allowed.
 *
 * Only the labels are friendly. The stored value stays the real token, so a
 * query saved with `$__interval` keeps working and the SQL preview still shows
 * what is actually being interpolated.
 */
function intervalVariableOptions(): VariableOption[] {
  const builtIns: VariableOption[] = [
    {
      label: 'Auto ($__interval)',
      value: '$__interval',
      description: 'Automatically computed from the panel width and time range — changes as you resize or zoom',
    },
    {
      label: 'Auto, ms ($__interval_ms)',
      value: '$__interval_ms',
      description: 'The same automatic value expressed in milliseconds',
    },
  ];

  let dashboardVariables: VariableOption[] = [];
  try {
    dashboardVariables = getTemplateSrv()
      .getVariables()
      // Ad Hoc and interval-list variables are not bucket sizes.
      .filter((variable) => variable.type !== 'adhoc')
      .map((variable) => ({
        label: `\${${variable.name}}`,
        value: `\${${variable.name}}`,
        description: 'Dashboard variable — one value for every panel on this dashboard',
      }));
  } catch {
    // No template service (for example a unit test render): built-ins only.
    dashboardVariables = [];
  }

  return [...builtIns, ...dashboardVariables];
}

interface Props {
  value?: string;
  onChange: (interval: string) => void;
  ariaLabel?: string;
}

/**
 * Interval input for the builder modes.
 *
 * The value may be a literal (`15m`) or a variable (`${interval}`,
 * `$__interval`). A variable lets one dashboard drive the bucket size of every
 * panel, which the SQL preview and the backend interpolation both support.
 */
export function IntervalPicker({ value, onChange, ariaLabel = 'Interval' }: Props) {
  const current = value ?? '5m';
  const mode = modeOf(current);
  const fixedOptions = PRESET_INTERVALS.map((interval) => ({ label: interval, value: interval }));
  const variableOptions = intervalVariableOptions();

  const selectMode = (next: IntervalMode) => {
    if (next === mode) {
      return;
    }
    if (next === 'fixed') {
      onChange('5m');
      return;
    }
    // Seed a variable that is guaranteed to resolve. A dashboard variable is
    // preferred because that is what this mode is for, but `${interval}` does
    // not exist on every dashboard and an unresolved token would reach KWDB as
    // literal text, so the always-available built-in is the fallback.
    const dashboardVariable = variableOptions.find((option) => option.value.startsWith('${'));
    onChange(dashboardVariable?.value ?? '$__interval');
  };

  return (
    <Stack gap={1} alignItems="center">
      <RadioButtonGroup<IntervalMode>
        aria-label={`${ariaLabel} source`}
        size="sm"
        options={[
          { label: 'Fixed', value: 'fixed' },
          { label: 'Variable', value: 'variable' },
        ]}
        value={mode}
        onChange={selectMode}
      />
      {mode === 'variable' ? (
        <Select<string>
          aria-label={ariaLabel}
          width={30}
          options={variableOptions}
          value={variableOptions.find((option) => option.value === current) ?? { label: current, value: current }}
          placeholder="Select or type a variable"
          // A dashboard variable that is not currently defined can still be
          // typed, which keeps shared query JSON working across dashboards.
          allowCustomValue
          createOptionPosition="first"
          onCreateOption={(variable) => onChange(variable)}
          formatCreateLabel={(input) => `Use ${input}`}
          onChange={(item) => onChange(item?.value ?? '')}
          menuShouldPortal={false}
        />
      ) : (
        <Select<string>
          aria-label={ariaLabel}
          options={fixedOptions}
          value={current ? { label: current, value: current } : undefined}
          onChange={(item) => onChange(item?.value ?? '')}
          placeholder="Type or select interval (e.g. 5m, 90s)"
          allowCustomValue
          createOptionPosition="first"
          onCreateOption={(interval) => onChange(interval)}
          formatCreateLabel={(input) => input}
          isClearable
          menuShouldPortal={false}
          width={24}
        />
      )}
    </Stack>
  );
}
