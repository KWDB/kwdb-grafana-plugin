import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';

import { SqlPreview } from '../src/components/querybuilder/SqlPreview';

// CodeEditor mounts monaco in the real app; a textarea keeps these tests focused on the
// surrounding behavior (copy, resize) instead of editor internals.
jest.mock('@grafana/ui', () => {
  const ReactModule = require('react');
  const actual = jest.requireActual('@grafana/ui');
  return {
    ...actual,
    CodeEditor: (props: { value?: string; height?: number }) =>
      ReactModule.createElement('textarea', {
        'aria-label': 'SQL',
        'data-testid': 'code-editor',
        'data-height': props.height,
        value: props.value ?? '',
        readOnly: true,
      }),
  };
});

function resizeHandle(): HTMLElement {
  return screen.getByTestId('sql-preview-resize-handle');
}

function editor(): HTMLTextAreaElement {
  return screen.getByTestId('code-editor') as HTMLTextAreaElement;
}

describe('SqlPreview', () => {
  const originalClipboard = navigator.clipboard;

  afterEach(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: originalClipboard,
      configurable: true,
      writable: true,
    });
    jest.useRealTimers();
  });

  it('renders the generated SQL read-only', () => {
    render(<SqlPreview sql="SELECT * FROM t" />);
    expect(editor().value).toBe('SELECT * FROM t');
    expect(editor().readOnly).toBe(true);
  });

  it('reports a successful copy', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });

    render(<SqlPreview sql="SELECT 1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }));

    expect(await screen.findByRole('button', { name: 'Copy SQL' })).toHaveTextContent('Copied');
    expect(writeText).toHaveBeenCalledWith('SELECT 1');
  });

  it('does not call the clipboard for an empty statement', () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });

    render(<SqlPreview sql="" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }));

    expect(writeText).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Copy SQL' })).toHaveTextContent('Copy');
  });

  it('stays usable when the clipboard is unavailable', async () => {
    // Embedded and non-HTTPS contexts reject clipboard access; the button must not
    // break the editor or leave the UI stuck on "Copied".
    const writeText = jest.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true, writable: true });

    render(<SqlPreview sql="SELECT 1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Copy SQL' })).toHaveTextContent('Copy');
    expect(editor().value).toBe('SELECT 1');
  });

  it('does not throw when navigator.clipboard is missing entirely', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true, writable: true });

    render(<SqlPreview sql="SELECT 1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy SQL' }));

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole('button', { name: 'Copy SQL' })).toHaveTextContent('Copy');
  });

  it('clamps the editor height while dragging the resize handle', () => {
    render(<SqlPreview sql="SELECT 1" />);
    // The height reaches CodeEditor as a prop, so the mock records it as data-height.
    const height = () => Number(editor().getAttribute('data-height'));
    expect(height()).toBe(140);

    fireEvent.mouseDown(resizeHandle(), { clientY: 100 });
    fireEvent.mouseMove(window, { clientY: 260 });
    expect(height()).toBe(300);

    // Dragging far past the maximum must stop at the ceiling instead of growing forever.
    fireEvent.mouseMove(window, { clientY: 5000 });
    expect(height()).toBe(600);

    // And dragging above the minimum must not collapse the editor.
    fireEvent.mouseMove(window, { clientY: -5000 });
    expect(height()).toBe(140);

    fireEvent.mouseUp(window);
  });
});
