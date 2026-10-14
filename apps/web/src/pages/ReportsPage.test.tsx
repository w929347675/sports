// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { ReportsPage } from './ReportsPage.js';
import { ReportDetailPage } from './ReportDetailPage.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listProfileRecommendations: vi.fn(),
    getProfileById: vi.fn(),
    getProfileRecommendation: vi.fn(),
    deleteProfileRecommendation: vi.fn(),
    bulkDeleteProfileRecommendations: vi.fn(),
    downloadRecommendationExport: vi.fn(),
  },
}));

vi.mock('../api/client.js', () => ({ api: apiMock }));

const currentProfile = {
  id: 7,
  name: '当前档案',
  status: 'active',
  goal: 'maintain',
  goal_description: '',
  height_cm: 175,
  age: 30,
  sex: 'unspecified',
  training_experience: 'beginner',
  equipment: 'home',
  training_days_per_week: 3,
  session_duration_minutes: 45,
  diet_preferences: '',
  allergies: '',
  health_restrictions: '',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  archived_at: null,
} as ProfileRecord;

const report = {
  id: 41,
  profile_id: 7,
  range_start: '2026-09-18',
  range_end: '2026-10-01',
  model_name: 'model-a',
  generated_at: '2026-10-01T10:00:00Z',
  input_record_count: 9,
  image_review_count: 2,
  input_summary_json: JSON.stringify({ recordCount: 9, imageCount: 2, highRisk: true }),
  report_markdown: '# Summary',
  structured_report_json: '{}',
  status: 'completed',
  inputSummary: { recordCount: 9, imageCount: 2, highRisk: true },
  report: {
    summary: '阶段总结',
    trend: { observations: ['趋势观察'] },
    trainingPlan: [{ day: 1, focus: '恢复', exercises: ['拉伸'] }],
    dietAdvice: ['饮食建议'],
    recovery: ['恢复建议'],
    followUps: ['后续跟进'],
    safety: { level: 'high', banner: 'Caution' },
    uncertainties: ['不确定性'],
  },
  profile: { id: 7, name: '当前档案' },
};

beforeEach(() => {
  apiMock.listProfileRecommendations.mockResolvedValue({ items: [report], total: 1, page: 1, pageSize: 25 });
  apiMock.getProfileById.mockResolvedValue({ ...currentProfile, id: 9, name: '归档档案', status: 'archived' });
  apiMock.getProfileRecommendation.mockResolvedValue(report);
  apiMock.deleteProfileRecommendation.mockResolvedValue({ id: report.id });
  apiMock.bulkDeleteProfileRecommendations.mockResolvedValue({ deleted: [report.id] });
  apiMock.downloadRecommendationExport.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ReportsPage', () => {
  it('lists the current profile reports with explicit scope and opens a report', async () => {
    const navigate = vi.fn();
    render(<ReportsPage currentProfile={currentProfile} navigate={navigate} />);

    expect(await screen.findByText('2026-09-18 至 2026-10-01')).toBeTruthy();
    expect(screen.getByText('model-a')).toBeTruthy();
    expect(screen.getByText(/9 条输入/)).toBeTruthy();
    expect(screen.getByText(/复核图片 2 张/)).toBeTruthy();
    expect(screen.getByRole('main').querySelector('.risk-flag')?.textContent).toBe('高风险');
    expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.objectContaining({
      status: '',
      from: '',
      to: '',
      risk: '',
      hasImages: '',
      sort: 'generated_at',
      order: 'desc',
    }));

    fireEvent.click(screen.getByRole('button', { name: /2026-09-18 至 2026-10-01/ }));
    expect(navigate).toHaveBeenCalledWith('/reports/7/41');
  });

  it('requires a second confirmation before deleting a selected report', async () => {
    render(<ReportsPage currentProfile={currentProfile} navigate={vi.fn()} />);

    await screen.findByText('2026-09-18 至 2026-10-01');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择报告 41' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选报告' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(apiMock.deleteProfileRecommendation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我理解删除报告不可恢复/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(apiMock.deleteProfileRecommendation).toHaveBeenCalledWith(7, 41));
  });

  it('uses bulk deletion when two reports are selected', async () => {
    const secondReport = { ...report, id: 42, range_start: '2026-09-04', range_end: '2026-09-17' };
    apiMock.listProfileRecommendations.mockResolvedValue({ items: [report, secondReport], total: 2, page: 1, pageSize: 25 });
    apiMock.bulkDeleteProfileRecommendations.mockResolvedValue({ deleted: [41, 42] });

    render(<ReportsPage currentProfile={currentProfile} navigate={vi.fn()} />);

    await screen.findByText('2026-09-18 至 2026-10-01');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择报告 41' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '选择报告 42' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选报告' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /我理解删除报告不可恢复/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(apiMock.bulkDeleteProfileRecommendations).toHaveBeenCalledWith(7, [41, 42]));
    expect(apiMock.deleteProfileRecommendation).not.toHaveBeenCalled();
  });

  it('marks archived profiles read-only and hides delete controls', async () => {
    render(<ReportsPage currentProfile={{ ...currentProfile, status: 'archived' }} navigate={vi.fn()} />);

    expect(await screen.findByText('只读归档')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '生成新报告' })).toBeNull();
    expect(screen.queryByRole('button', { name: '删除所选报告' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: '选择报告 41' })).toBeNull();
  });

  it('loads an explicitly scoped archived profile report list', async () => {
    render(<ReportsPage currentProfile={currentProfile} profileId={9} navigate={vi.fn()} />);

    expect(await screen.findByText('只读归档')).toBeTruthy();
    expect(apiMock.getProfileById).toHaveBeenCalledWith(9);
    expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(9, expect.any(Object));
  });

  it('clears the previous scoped reports when a changed profile request fails', async () => {
    apiMock.getProfileById.mockImplementation((profileId: number) => Promise.resolve({
      ...currentProfile,
      id: profileId,
      name: profileId === 7 ? '档案 A' : '档案 B',
    }));
    apiMock.listProfileRecommendations.mockImplementation((profileId: number) => profileId === 7
      ? Promise.resolve({ items: [report], total: 1, page: 1, pageSize: 25 })
      : Promise.reject(new Error('档案 B 报告读取失败')));
    const view = render(<ReportsPage currentProfile={currentProfile} profileId={7} navigate={vi.fn()} />);

    expect(await screen.findByText('2026-09-18 至 2026-10-01')).toBeTruthy();
    expect(screen.getByText(/「档案 A」/)).toBeTruthy();

    view.rerender(<ReportsPage currentProfile={currentProfile} profileId={9} navigate={vi.fn()} />);

    expect((await screen.findByRole('alert')).textContent).toContain('档案 B 报告读取失败');
    expect(screen.queryByText('2026-09-18 至 2026-10-01')).toBeNull();
    expect(screen.queryByText(/「档案 A」/)).toBeNull();
  });

  it('shows pagination and requests the second page when more reports exist than fit on one page', async () => {
    const secondPageReport = { ...report, id: 66, range_start: '2026-08-21', range_end: '2026-09-03' };
    apiMock.listProfileRecommendations.mockImplementation((_profileId: number, query: { page?: number }) => Promise.resolve(
      query.page === 2
        ? { items: [secondPageReport], total: 26, page: 2, pageSize: 25 }
        : { items: [report], total: 26, page: 1, pageSize: 25 },
    ));

    render(<ReportsPage currentProfile={currentProfile} navigate={vi.fn()} />);

    await screen.findByText('2026-09-18 至 2026-10-01');
    const nextPage = screen.queryByRole('button', { name: '下一页' });
    expect(nextPage).not.toBeNull();
    fireEvent.click(nextPage!);

    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.objectContaining({ page: 2 })));
    expect(await screen.findByText('2026-08-21 至 2026-09-03')).toBeTruthy();
  });

  it('clears page-two reports, pagination, and delete dialog when a scoped reload fails', async () => {
    const secondPageReport = { ...report, id: 66, range_start: '2026-08-21', range_end: '2026-09-03' };
    let pageTwoRequests = 0;
    let rejectReload!: (cause: Error) => void;
    apiMock.listProfileRecommendations.mockImplementation((_profileId: number, query: { page?: number }) => {
      if (query.page !== 2) return Promise.resolve({ items: [report], total: 26, page: 1, pageSize: 25 });
      pageTwoRequests += 1;
      if (pageTwoRequests === 1) return Promise.resolve({ items: [secondPageReport], total: 26, page: 2, pageSize: 25 });
      return new Promise((_resolve, reject) => { rejectReload = reject; });
    });

    const view = render(<ReportsPage currentProfile={currentProfile} navigate={vi.fn()} />);

    await screen.findByText('2026-09-18 至 2026-10-01');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('2026-08-21 至 2026-09-03');
    fireEvent.click(screen.getByRole('checkbox', { name: '选择报告 66' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选报告' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    view.rerender(<ReportsPage currentProfile={{ ...currentProfile }} navigate={vi.fn()} />);
    await waitFor(() => expect(pageTwoRequests).toBe(2));
    rejectReload(new Error('第 2 页报告重新读取失败'));

    expect((await screen.findByRole('alert')).textContent).toContain('第 2 页报告重新读取失败');
    expect(screen.queryByRole('region', { name: '报告列表' })).toBeNull();
    expect(screen.queryByRole('button', { name: /2026-09-18 至 2026-10-01/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /2026-08-21 至 2026-09-03/ })).toBeNull();
    expect.soft(screen.queryByRole('button', { name: '上一页' })).toBeNull();
    expect.soft(screen.queryByRole('button', { name: '下一页' })).toBeNull();
    expect.soft(screen.queryByRole('dialog')).toBeNull();
  });

  it('returns to page one when deleting the only report on page two', async () => {
    const secondPageReport = { ...report, id: 66, range_start: '2026-08-21', range_end: '2026-09-03' };
    let deleted = false;
    apiMock.listProfileRecommendations.mockImplementation((_profileId: number, query: { page?: number }) => {
      const page = query.page ?? 1;
      if (!deleted && page === 2) return Promise.resolve({ items: [secondPageReport], total: 26, page: 2, pageSize: 25 });
      if (deleted && page === 1) return Promise.resolve({ items: [report], total: 25, page: 1, pageSize: 25 });
      if (deleted && page === 2) return Promise.resolve({ items: [], total: 25, page: 2, pageSize: 25 });
      return Promise.resolve({ items: [report], total: 26, page: 1, pageSize: 25 });
    });
    apiMock.deleteProfileRecommendation.mockImplementation(async () => { deleted = true; return { id: secondPageReport.id }; });

    render(<ReportsPage currentProfile={currentProfile} navigate={vi.fn()} />);

    await screen.findByText('2026-09-18 至 2026-10-01');
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    await screen.findByText('2026-08-21 至 2026-09-03');
    fireEvent.click(screen.getByRole('button', { name: '删除报告 66' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /我理解删除报告不可恢复/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.objectContaining({ page: 1 })));
    expect(await screen.findByText('2026-09-18 至 2026-10-01')).toBeTruthy();
    expect(screen.queryByText('2026-08-21 至 2026-09-03')).toBeNull();
  });
});

describe('ReportDetailPage', () => {
  it('keeps an active non-current profile detail scoped and does not offer unscoped regeneration', async () => {
    const navigate = vi.fn();
    const viewedProfile = { ...currentProfile, id: 9, name: '另一个活动档案' };
    apiMock.getProfileById.mockResolvedValue(viewedProfile);
    apiMock.getProfileRecommendation.mockResolvedValue({ ...report, profile_id: 9, profile: { id: 9, name: viewedProfile.name } });

    render(<ReportDetailPage profileId={9} reportId={41} currentProfile={currentProfile} navigate={navigate} />);

    expect(await screen.findByRole('heading', { name: '另一个活动档案' })).toBeTruthy();
    expect(apiMock.getProfileRecommendation).toHaveBeenCalledWith(9, 41);
    expect(apiMock.getProfileById).toHaveBeenCalledWith(9);
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeTruthy();
    const regenerate = screen.queryByRole('button', { name: '重新生成' });
    expect(regenerate === null || regenerate.hasAttribute('disabled')).toBe(true);
    if (regenerate) fireEvent.click(regenerate);
    expect(navigate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));
    await waitFor(() => expect(apiMock.downloadRecommendationExport).toHaveBeenCalledWith(9, 41, 'markdown'));
  });

  it('requires second confirmation to delete an active detail and returns to its scoped report list', async () => {
    const navigate = vi.fn();
    apiMock.getProfileById.mockResolvedValue(currentProfile);
    apiMock.getProfileRecommendation.mockResolvedValue(report);

    render(<ReportDetailPage profileId={7} reportId={41} currentProfile={currentProfile} navigate={navigate} />);

    const deleteButton = screen.queryByRole('button', { name: /删除报告/ });
    expect(deleteButton).not.toBeNull();
    fireEvent.click(deleteButton!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(apiMock.deleteProfileRecommendation).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('checkbox', { name: /我理解删除报告不可恢复/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));

    await waitFor(() => expect(apiMock.deleteProfileRecommendation).toHaveBeenCalledWith(7, 41));
    expect(navigate).toHaveBeenCalledWith('/reports/7');
  });

  it('clears the previous report and profile while a changed detail request is pending or fails', async () => {
    let rejectNext!: (cause: Error) => void;
    apiMock.getProfileById.mockImplementation((profileId: number) => Promise.resolve({
      ...currentProfile,
      id: profileId,
      name: profileId === 7 ? '档案 A' : '档案 B',
    }));
    apiMock.getProfileRecommendation.mockImplementation((profileId: number) => profileId === 7
      ? Promise.resolve(report)
      : new Promise((_resolve, reject) => { rejectNext = reject; }));
    const view = render(<ReportDetailPage profileId={7} reportId={41} currentProfile={currentProfile} navigate={vi.fn()} />);

    expect((await screen.findAllByText('阶段总结')).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: '档案 A' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeTruthy();

    view.rerender(<ReportDetailPage profileId={9} reportId={42} currentProfile={currentProfile} navigate={vi.fn()} />);

    expect(screen.getByText('正在读取报告...')).toBeTruthy();
    rejectNext(new Error('档案 B 报告不存在'));

    expect((await screen.findByText('档案 B 报告不存在')).textContent).toContain('档案 B 报告不存在');
    expect(screen.queryByText('阶段总结')).toBeNull();
    expect(screen.queryByRole('heading', { name: '档案 A' })).toBeNull();
    expect(screen.queryByRole('button', { name: '导出 Markdown' })).toBeNull();
  });
});
