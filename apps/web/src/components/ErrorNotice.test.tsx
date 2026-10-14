// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ErrorNotice } from './ErrorNotice.js';

describe('ErrorNotice', () => {
  it('shows the safe error details and lets the user retry', () => {
    const retry = vi.fn();
    render(<ErrorNotice message="本地服务暂时不可用" code="INTERNAL_ERROR" requestId="req-safe-1" onRetry={retry} />);

    expect(screen.getByRole('alert').textContent).toContain('本地服务暂时不可用');
    expect(screen.getByRole('alert').textContent).toContain('INTERNAL_ERROR');
    expect(screen.getByRole('alert').textContent).toContain('req-safe-1');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(retry).toHaveBeenCalledWith();
  });
});
