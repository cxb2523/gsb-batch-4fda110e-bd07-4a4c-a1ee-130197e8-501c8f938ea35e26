// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { SeedSearch } from './SeedSearch';

function mockFetchJson(results: { title: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.resolve({
      ok: true,
      json: async () => results,
    })),
  );
}

// The component debounces requests by 200ms; wait past that before asserting.
async function waitForDebounce() {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

describe('SeedSearch', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('navigates suggestions with the keyboard, wrapping at the ends, and selects with Enter', async () => {
    mockFetchJson([{ title: 'Quantum mechanics' }, { title: 'Quantum computing' }]);
    const onSearch = vi.fn();
    render(<SeedSearch onSearch={onSearch} isLoading={false} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Quantum' } });
    await waitForDebounce();

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(2));
    const options = screen.getAllByRole('option');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Home' });
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'End' });
    expect(options[1]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearch).toHaveBeenCalledWith('Quantum computing');
  });

  it('shows a "search anyway" row when there are no results and submits the typed text', async () => {
    mockFetchJson([]);
    const onSearch = vi.fn();
    render(<SeedSearch onSearch={onSearch} isLoading={false} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Zzzznotarealarticle' } });
    await waitForDebounce();

    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(1));
    expect(screen.getByRole('option')).toHaveTextContent(
      'No article found. Search "Zzzznotarealarticle" anyway',
    );

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearch).toHaveBeenCalledWith('Zzzznotarealarticle');
  });

  it('starts a search when a suggestion is clicked', async () => {
    mockFetchJson([{ title: 'Climate change' }]);
    const onSearch = vi.fn();
    render(<SeedSearch onSearch={onSearch} isLoading={false} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Climate' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Climate change/ })).toBeInTheDocument());

    const suggestion = screen.getByRole('option', { name: /Climate change/ });
    fireEvent.mouseDown(suggestion);
    fireEvent.click(suggestion);

    expect(onSearch).toHaveBeenCalledWith('Climate change');
    await waitFor(() => expect(input).toHaveValue('Climate change'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('does not render an empty dropdown while a search is still in flight', async () => {
    mockFetchJson([]);
    render(<SeedSearch onSearch={vi.fn()} isLoading={false} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Something' } });

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('shows a busy message instead of a no-results action when search is throttled', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 503 })));
    const onSearch = vi.fn();
    render(<SeedSearch onSearch={onSearch} isLoading={false} />);

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Quantum' } });
    await waitForDebounce();

    expect(await screen.findByText('Search is busy. Please try again shortly.')).toBeInTheDocument();
    expect(screen.getByText('Search is busy. Please try again shortly.')).toHaveTextContent(
      'Search is busy. Please try again shortly.',
    );
    expect(screen.queryByRole('option')).not.toBeInTheDocument();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSearch).not.toHaveBeenCalled();
  });
});
