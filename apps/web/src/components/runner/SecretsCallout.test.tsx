import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { SecretsCallout } from './SecretsCallout';

describe('SecretsCallout', () => {
  it('renders nothing when secrets list is empty', () => {
    const { container } = render(<SecretsCallout secrets={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the callout and lists all secrets when provided', () => {
    const secrets = ['OPENAI_API_KEY', 'GITHUB_TOKEN'];
    render(<SecretsCallout secrets={secrets} />);

    expect(screen.getByTestId('secrets-callout')).toBeInTheDocument();
    expect(screen.getByText(/Detected secrets needed/i)).toBeInTheDocument();
    
    secrets.forEach(s => {
      expect(screen.getByText(s)).toBeInTheDocument();
    });
  });
});
