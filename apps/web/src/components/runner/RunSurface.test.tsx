import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { RunSurface } from './RunSurface';
import { MemoryRouter } from 'react-router-dom';

// Minimal mock for RunSurface props
const mockApp = {
  slug: 'test-app',
  name: 'Test App',
  description: 'Test Description',
  actions: ['run'],
  manifest: {
    actions: {
      run: {
        label: 'Run',
        inputs: [],
        outputs: []
      }
    }
  }
} as any;

// Mock the hooks used in RunSurface
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom' as any) as any;
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
  };
});

vi.mock('../hooks/useSession', () => ({
  useSession: () => ({ session: null, loading: false }),
}));

describe('RunSurface Preview Mode', () => {
  it('disables the run button and shows preview hint when preview=true', () => {
    render(
      <MemoryRouter>
        <RunSurface app={mockApp} preview={true} />
      </MemoryRouter>
    );

    // There are two run buttons (one for empty inputs, one for forms)
    const runButtons = screen.getAllByTestId('run-surface-run-btn');
    runButtons.forEach(btn => {
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('aria-disabled', 'true');
    });
    
    expect(screen.getByText(/Preview only — Run works after publish/i)).toBeInTheDocument();
  });
});
