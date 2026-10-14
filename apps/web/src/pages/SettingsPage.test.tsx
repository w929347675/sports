// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SettingsPage } from './SettingsPage.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    getModelSettings: vi.fn(),
    saveModelSettings: vi.fn(),
    clearModelSettings: vi.fn(),
    testModelConnection: vi.fn(),
    listBackups: vi.fn(),
    createBackup: vi.fn(),
    downloadJsonExport: vi.fn(),
  },
}));

vi.mock('../api/client.js', () => ({ api: apiMock }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function configureSettings() {
  apiMock.getModelSettings.mockResolvedValue({ baseUrl: 'http://127.0.0.1:4321/v1', modelName: 'test-model', configured: true });
  apiMock.listBackups.mockResolvedValue([]);
}

describe('SettingsPage', () => {
  it('does not overwrite user input when the initial settings request resolves late', async () => {
    let resolveSettings!: (value: { baseUrl?: string; modelName?: string; configured: boolean }) => void;
    apiMock.getModelSettings.mockReturnValue(new Promise((resolve) => { resolveSettings = resolve; }));

    render(<SettingsPage />);

    fireEvent.change(screen.getByLabelText('Base URL'), { target: { value: 'http://127.0.0.1:4321/v1' } });
    fireEvent.change(screen.getByLabelText('模型名'), { target: { value: 'test-only-model' } });
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'test-only-key' } });

    resolveSettings({ baseUrl: '', modelName: '', configured: false });

    expect(await screen.findByDisplayValue('http://127.0.0.1:4321/v1')).toBeTruthy();
    expect(screen.getByDisplayValue('test-only-model')).toBeTruthy();
    expect(screen.getByDisplayValue('test-only-key')).toBeTruthy();
  });

  it('tests the saved connection without putting the API key in the browser request', async () => {
    configureSettings();
    apiMock.testModelConnection.mockResolvedValue({ connected: true, modelName: 'test-model' });
    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '测试连接' }));

    expect(await screen.findByText('连接成功：test-model')).toBeTruthy();
    expect(apiMock.testModelConnection).toHaveBeenCalledWith();
  });

  it('creates a local backup and refreshes recent backup status', async () => {
    configureSettings();
    apiMock.createBackup.mockResolvedValue({ filename: 'backup-2026.tar.gz', size: 128, manifest: { schema_version: 1 } });
    apiMock.listBackups
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ filename: 'backup-2026.tar.gz', size: 128, createdAt: '2026-10-09T12:00:00.000Z' }]);

    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '创建本地备份' }));

    expect(await screen.findByText('backup-2026.tar.gz')).toBeTruthy();
    expect(apiMock.createBackup).toHaveBeenCalledWith();
    expect(apiMock.listBackups).toHaveBeenCalledTimes(2);
  });

  it('exports JSON with the explicitly selected image option', async () => {
    configureSettings();
    apiMock.downloadJsonExport.mockResolvedValue(undefined);
    render(<SettingsPage />);

    fireEvent.click(await screen.findByLabelText('导出时包含图片'));
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));

    expect(await screen.findByText('导出已下载到本机')).toBeTruthy();
    expect(apiMock.downloadJsonExport).toHaveBeenCalledWith(true);
  });

  it('shows a safe error when backup creation fails', async () => {
    configureSettings();
    apiMock.createBackup.mockRejectedValue(new Error('备份失败'));
    render(<SettingsPage />);

    fireEvent.click(await screen.findByRole('button', { name: '创建本地备份' }));

    expect(await screen.findByText('备份失败')).toBeTruthy();
  });
});
