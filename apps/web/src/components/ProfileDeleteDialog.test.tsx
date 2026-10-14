// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ProfileDeleteDialog } from './ProfileDeleteDialog.js';

afterEach(cleanup);

describe('ProfileDeleteDialog', () => {
  it('names every profile and requires an explicit second confirmation', () => {
    const onConfirm = vi.fn();
    render(<ProfileDeleteDialog profiles={[
      { id: 1, name: 'Runner', status: 'active', record_days: 2, report_count: 1 },
      { id: 2, name: 'Archive', status: 'archived', record_days: 4, report_count: 3 },
    ]} onCancel={vi.fn()} onConfirm={onConfirm} />);

    expect(screen.getByText(/不会自动备份/)).toBeTruthy();
    expect(screen.getByText(/操作不可恢复/)).toBeTruthy();
    expect(screen.getByText(/Runner/)).toBeTruthy();
    expect(screen.getByText(/Archive/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: '永久删除' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('我理解这些档案及其记录、图片和报告将被永久删除'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
