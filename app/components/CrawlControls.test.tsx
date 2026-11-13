// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CrawlControls } from './CrawlControls';

afterEach(() => cleanup());

describe('CrawlControls', () => {
  it('keeps the depth and node budget ranges accessible and reports changes', () => {
    const onDepthChange = vi.fn();
    const onMaxNodesChange = vi.fn();
    render(
      <CrawlControls
        depth={2}
        maxNodes={250}
        onDepthChange={onDepthChange}
        onMaxNodesChange={onMaxNodesChange}
      />,
    );

    const depth = screen.getByRole('slider', { name: 'Crawl depth' });
    const maxNodes = screen.getByRole('slider', { name: 'Maximum crawled nodes' });
    expect(depth).toHaveAttribute('min', '1');
    expect(depth).toHaveAttribute('max', '3');
    expect(depth).toHaveValue('2');
    expect(maxNodes).toHaveAttribute('min', '50');
    expect(maxNodes).toHaveAttribute('max', '500');
    expect(maxNodes).toHaveAttribute('step', '50');
    expect(maxNodes).toHaveValue('250');

    fireEvent.change(depth, { target: { value: '3' } });
    fireEvent.change(maxNodes, { target: { value: '300' } });
    expect(onDepthChange).toHaveBeenCalledWith(3);
    expect(onMaxNodesChange).toHaveBeenCalledWith(300);
  });
});
