// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HistoryPage } from './HistoryPage.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  listDailyEntries: vi.fn().mockRejectedValue(new Error('本地服务暂时不可用')),
  getDailyEntry: vi.fn(),
} }));

vi.mock('../api/client.js', () => ({ api: apiMock }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('HistoryPage', () => {
  it('shows a read error instead of an empty history when the local API fails', async () => {
    render(<HistoryPage navigate={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('本地服务暂时不可用');
    expect(screen.getByRole('button', { name: '重试读取' })).toBeTruthy();
  });
});
