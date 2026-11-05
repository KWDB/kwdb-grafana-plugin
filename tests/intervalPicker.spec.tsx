import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';

import { IntervalPicker } from '../src/components/querybuilder/shared/IntervalPicker';

const mockGetVariables = jest.fn();

jest.mock('@grafana/runtime', () => {
  const actual = jest.requireActual('@grafana/runtime');
  return {
    ...actual,
    getTemplateSrv: () => ({
      getVariables: mockGetVariables,
    }),
  };
});

function lastCall(fn: jest.Mock): string {
  expect(fn).toHaveBeenCalled();
  return fn.mock.calls[fn.mock.calls.length - 1][0];
}

describe('IntervalPicker', () => {
  beforeEach(() => {
    mockGetVariables.mockReset();
    mockGetVariables.mockReturnValue([]);
  });

  it('shows a literal interval in fixed mode', () => {
    render(<IntervalPicker value="15m" onChange={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Fixed' })).toBeChecked();
    expect(screen.getByText('15m')).toBeInTheDocument();
  });

  it('switches to a variable token as soon as the value contains a $', () => {
    render(<IntervalPicker value="$__interval" onChange={jest.fn()} />);
    expect(screen.getByRole('radio', { name: 'Variable' })).toBeChecked();
    expect(screen.getByText('Auto ($__interval)')).toBeInTheDocument();
  });

  it('seeds a dashboard variable when switching to variable mode', () => {
    mockGetVariables.mockReturnValue([{ name: 'granularity', type: 'custom' }]);
    const onChange = jest.fn();

    render(<IntervalPicker value="5m" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Variable' }));

    // `${granularity}` is preferred because it drives every panel on the dashboard.
    expect(lastCall(onChange)).toBe('${granularity}');
  });

  it('falls back to the built-in token when the dashboard defines no variable', () => {
    // `${interval}` is not defined on most dashboards; seeding it would send the
    // literal token to KWDB, so the always-resolving built-in must win.
    const onChange = jest.fn();
    render(<IntervalPicker value="5m" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Variable' }));

    expect(lastCall(onChange)).toBe('$__interval');
  });

  it('ignores Ad Hoc variables when choosing a seed', () => {
    mockGetVariables.mockReturnValue([
      { name: 'filter', type: 'adhoc' },
      { name: 'bucket', type: 'custom' },
    ]);
    const onChange = jest.fn();

    render(<IntervalPicker value="5m" onChange={onChange} />);
    fireEvent.click(screen.getByRole('radio', { name: 'Variable' }));

    expect(lastCall(onChange)).toBe('${bucket}');
  });

  it('still offers the built-ins when the template service throws', () => {
    // getTemplateSrv throws when the picker renders outside a dashboard (unit tests,
    // embedded usage). The control must keep working with built-ins only.
    mockGetVariables.mockImplementation(() => {
      throw new Error('no template service');
    });

    render(<IntervalPicker value="$__interval" onChange={jest.fn()} />);
    // The selected option's label proves the built-in list survived the throw.
    expect(screen.getByText('Auto ($__interval)')).toBeInTheDocument();
  });

  it('returns to a concrete interval when switching back to fixed', () => {
    const onChange = jest.fn();
    render(<IntervalPicker value="${granularity}" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Fixed' }));

    expect(lastCall(onChange)).toBe('5m');
  });

  it('does not emit when re-selecting the active mode', () => {
    const onChange = jest.fn();
    render(<IntervalPicker value="5m" onChange={onChange} />);

    fireEvent.click(screen.getByRole('radio', { name: 'Fixed' }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
