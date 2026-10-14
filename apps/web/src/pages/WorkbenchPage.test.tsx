// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { WorkbenchPage } from './WorkbenchPage.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getDailyEntry: vi.fn().mockRejectedValue(new Error('本地服务暂时不可用')),
    listDailyEntries: vi.fn().mockRejectedValue(new Error('本地服务暂时不可用')),
  },
}));

vi.mock('../api/client.js', () => ({ api: apiMock }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('WorkbenchPage', () => {
  it('shows a read error instead of presenting failed data as an empty trend', async () => {
    render(<WorkbenchPage navigate={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('本地服务暂时不可用');
    expect(screen.getByRole('button', { name: '重试读取' })).toBeTruthy();
  });
});
