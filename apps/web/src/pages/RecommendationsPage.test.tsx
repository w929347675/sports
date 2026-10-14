// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ProfileRecord, RecommendationJob } from '@fitness-coach/shared';
import { RecommendationsPage } from './RecommendationsPage.js';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    listRecommendations: vi.fn(),
    previewRecommendation: vi.fn(),
    getRecommendation: vi.fn(),
    listProfileRecommendations: vi.fn(),
    createRecommendationJob: vi.fn(),
    getRecommendationJob: vi.fn(),
    cancelRecommendationJob: vi.fn(),
    retryRecommendationJob: vi.fn(),
  },
}));

vi.mock('../api/client.js', () => ({ api: apiMock }));

function apiError(code: string, message: string, status: number) {
  return Object.assign(new Error(message), { code, status });
}

const recommendationReport = {
  summary: '训练频率稳定，但恢复和蛋白质摄入仍有改进空间。',
  trend: {
    observations: ['体重在记录范围内保持稳定。', '训练集中在工作周前半段。'],
  },
  trainingPlan: Array.from({ length: 7 }, (_, index) => ({
    day: index + 1,
    focus: ['下肢力量', '主动恢复', '上肢力量', '休息与拉伸', '全身力量', '低强度有氧', '休息'][index],
    exercises: [['深蹲', '罗马尼亚硬拉'], ['快走', '髋部活动'], ['俯卧撑', '划船'], ['全身拉伸'], ['硬拉', '推举'], ['骑行'], ['呼吸练习']][index],
  })),
  dietAdvice: ['每餐优先安排明确来源的蛋白质。', '将未确认的食物估计视为区间而非精确摄入。'],
  recovery: ['保持规律睡眠，目标为每晚八小时。', '高强度训练之间至少安排一天恢复。'],
  followUps: ['七天后复查训练完成率。', '若疼痛持续或加重，应停止相关动作并寻求专业评估。'],
  safety: {
    level: 'high',
    banner: '记录中出现高风险疼痛，请停止受影响的训练并寻求专业评估。',
  },
  uncertainties: ['部分餐次没有用户确认的食物明细。', '缺少连续的睡眠时长记录。'],
};

const completedRecommendation = {
  id: 41,
  range_start: '2026-09-18',
  range_end: '2026-10-01',
  model_name: 'recommendation-model',
  generated_at: '2026-10-01T10:00:00Z',
  input_summary_json: JSON.stringify({ recordCount: 9, imageCount: 0, highRisk: true }),
  report_markdown: '# Summary\n\n训练频率稳定。',
  structured_report_json: JSON.stringify(recommendationReport),
  status: 'completed',
  inputSummary: { recordCount: 9, imageCount: 0, highRisk: true },
  report: recommendationReport,
};

const activeProfile = { id: 7, name: '当前档案', status: 'active' } as ProfileRecord;
const queuedJob = {
  job_id: 'job-queued-1',
  profile_id: 7,
  status: 'queued',
  phase_percent: 4,
  received_chars: 0,
  started_at: null,
  updated_at: '2026-10-13T10:00:00Z',
  completed_at: null,
  error_code: null,
  error_message: null,
  error_phase: null,
  request_id: 'request-queued-1',
  recommendation_id: null,
} as unknown as RecommendationJob;
const failedJob = {
  ...queuedJob,
  job_id: 'job-failed-1',
  status: 'failed',
  error_code: 'MODEL_TIMEOUT',
  error_message: '模型等待超时，请重试。',
  error_phase: 'waiting_model',
  request_id: 'request-failed-1',
} as unknown as RecommendationJob;
const completedJob = {
  ...queuedJob,
  status: 'completed',
  phase_percent: 100,
  recommendation_id: 41,
  completed_at: '2026-10-13T10:01:00Z',
} as unknown as RecommendationJob;

function localDate(offsetDays = 0) {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offsetDays);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  apiMock.listRecommendations.mockResolvedValue([]);
  apiMock.previewRecommendation.mockResolvedValue({
    range: { start: localDate(-13), end: localDate() },
    inputSummary: { recordCount: 1, entryCount: 1, feedbackCount: 1, mealCount: 0, imageCount: 0, highRisk: true },
    imageCount: 0,
    highRisk: true,
    explicitReview: false,
    safety: { level: 'high', banner: '存在高风险不适。' },
  });
  apiMock.getRecommendation.mockResolvedValue(completedRecommendation);
  apiMock.getRecommendationJob.mockResolvedValue(queuedJob);
  apiMock.listProfileRecommendations.mockResolvedValue({ items: [], page: 1, pageSize: 25, total: 0 });
  apiMock.createRecommendationJob.mockReset();
  apiMock.getRecommendationJob.mockReset();
  apiMock.cancelRecommendationJob.mockReset();
  apiMock.retryRecommendationJob.mockReset();
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('RecommendationsPage', () => {
  it('defaults to today and the preceding 13 days without generating automatically', async () => {
    render(<RecommendationsPage />);

    await waitFor(() => expect(apiMock.listRecommendations).toHaveBeenCalledTimes(1));
    expect((screen.getByLabelText('开始日期') as HTMLInputElement).value).toBe(localDate(-13));
    expect((screen.getByLabelText('结束日期') as HTMLInputElement).value).toBe(localDate());
  });

  it('requires explicit transfer confirmation, sends the edited range, shows progress, and renders the completed report', async () => {
    apiMock.createRecommendationJob.mockResolvedValueOnce(queuedJob);
    apiMock.getRecommendationJob.mockResolvedValueOnce({ ...queuedJob, status: 'completed', phase_percent: 100, recommendation_id: 41 });
    apiMock.listProfileRecommendations.mockResolvedValue({ items: [completedRecommendation], page: 1, pageSize: 25, total: 1 });

    render(<RecommendationsPage currentProfile={activeProfile} />);
    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.any(Object), expect.any(AbortSignal)));

    fireEvent.change(screen.getByLabelText('开始日期'), { target: { value: '2026-09-10' } });
    fireEvent.change(screen.getByLabelText('结束日期'), { target: { value: '2026-09-16' } });
    fireEvent.click(screen.getByRole('button', { name: '生成建议' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    await waitFor(() => expect(apiMock.previewRecommendation).toHaveBeenCalledWith({
      start: '2026-09-10', end: '2026-09-16', explicitReview: false,
    }));

    fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选日期范围的数据传输给模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));

    await waitFor(() => expect(apiMock.createRecommendationJob).toHaveBeenCalledWith(7, {
      start: '2026-09-10',
      end: '2026-09-16',
      explicitReview: false,
    }));
    expect(screen.getByText('正在生成...')).toBeTruthy();

    expect(await screen.findByRole('heading', { name: '未来 7 天训练计划' }, { timeout: 3000 })).toBeTruthy();
  });

  it('renders the seven-day plan, diet, recovery, follow-ups, uncertainties, and prominent high-risk safety banner', async () => {
    apiMock.listRecommendations.mockResolvedValue([completedRecommendation]);

    render(<RecommendationsPage />);

    expect(await screen.findByRole('heading', { name: '未来 7 天训练计划' })).toBeTruthy();
    for (const day of recommendationReport.trainingPlan) {
      expect(screen.getByText(day.focus)).toBeTruthy();
      for (const exercise of day.exercises) expect(screen.getByText(exercise)).toBeTruthy();
    }
    expect(screen.getByRole('heading', { name: '饮食建议' })).toBeTruthy();
    expect(screen.getByText(recommendationReport.dietAdvice[0])).toBeTruthy();
    expect(screen.getByRole('heading', { name: '恢复' })).toBeTruthy();
    expect(screen.getByText(recommendationReport.recovery[0])).toBeTruthy();
    expect(screen.getByRole('heading', { name: '后续跟进' })).toBeTruthy();
    expect(screen.getByText(recommendationReport.followUps[0])).toBeTruthy();
    expect(screen.getByRole('heading', { name: '不确定性' })).toBeTruthy();
    expect(screen.getByText(recommendationReport.uncertainties[0])).toBeTruthy();

    const safetyBanner = screen.getByRole('alert');
    expect(safetyBanner.textContent).toContain('高风险疼痛');
    expect(safetyBanner.textContent).toContain('停止受影响的训练');
  });

  it('keeps image review opt-in and displays the report input coverage', async () => {
    apiMock.listProfileRecommendations.mockResolvedValue({ items: [completedRecommendation], page: 1, pageSize: 25, total: 1 });
    apiMock.createRecommendationJob.mockResolvedValue(queuedJob);
    render(<RecommendationsPage currentProfile={activeProfile} />);
    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.any(Object), expect.any(AbortSignal)));
    expect(await screen.findByText(/用于分析 9 条记录/)).toBeTruthy();
    expect(screen.getByText(/复核图片 0 张/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '生成建议' }));
    expect(await screen.findByText('生成前安全提示')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /允许发送最多 5 张相关图片用于复核/ }));
    await waitFor(() => expect(apiMock.previewRecommendation).toHaveBeenLastCalledWith({
      start: localDate(-13),
      end: localDate(),
      explicitReview: true,
    }));
    fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选日期范围的数据传输给模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));

    await waitFor(() => expect(apiMock.createRecommendationJob).toHaveBeenCalledWith(7, {
      start: localDate(-13),
      end: localDate(),
      explicitReview: true,
    }));
  });

  it('does not offer report generation for an archived current profile', async () => {
    render(<RecommendationsPage currentProfile={{ id: 7, name: '归档档案', status: 'archived' } as ProfileRecord} />);

    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.any(Object), expect.any(AbortSignal)));
    expect(screen.queryByRole('button', { name: '生成建议' })).toBeNull();
  });

  it('creates a profile-scoped job after confirmation instead of calling synchronous generation', async () => {
    apiMock.createRecommendationJob.mockResolvedValue(queuedJob);
    render(<RecommendationsPage currentProfile={activeProfile} />);

    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledWith(7, expect.any(Object), expect.any(AbortSignal)));
    fireEvent.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('生成前安全提示');
    fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选日期范围的数据传输给模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));

    await waitFor(() => expect(apiMock.createRecommendationJob).toHaveBeenCalledWith(7, {
      start: localDate(-13), end: localDate(), explicitReview: false,
    }));
    expect(screen.getByText('job-queued-1')).toBeTruthy();
    expect((screen.getByRole('button', { name: '生成建议' }) as HTMLButtonElement).disabled).toBe(true);
    expect(window.localStorage.getItem('recommendation-job-7')).toBe('job-queued-1');
  });

  it('restores a stored job, opens the completed report, and clears the stored job id', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    apiMock.getRecommendationJob.mockResolvedValue(completedJob);
    const navigate = vi.fn();
    render(<RecommendationsPage currentProfile={activeProfile} navigate={navigate} />);

    await waitFor(() => expect(apiMock.getRecommendationJob).toHaveBeenCalledWith(7, 'job-queued-1', expect.any(AbortSignal)));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/7/41'));
    expect(window.localStorage.getItem('recommendation-job-7')).toBeNull();
  });

  it('shows safe failure details and retries a failed job without exposing the response body', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-failed-1');
    apiMock.getRecommendationJob.mockResolvedValue(failedJob);
    apiMock.retryRecommendationJob.mockResolvedValue(queuedJob);
    render(<RecommendationsPage currentProfile={activeProfile} />);

    expect((await screen.findByRole('alert')).textContent).toContain('MODEL_TIMEOUT');
    expect(screen.getByRole('alert').textContent).toContain('waiting_model');
    expect(screen.getByRole('alert').textContent).toContain('request-failed-1');
    expect(screen.queryByText(/完整模型响应|api[_ -]?key|base64/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试生成' }));
    await waitFor(() => expect(apiMock.retryRecommendationJob).toHaveBeenCalledWith(7, 'job-failed-1'));
    expect(window.localStorage.getItem('recommendation-job-7')).toBe('job-queued-1');
  });

  it('shows the safe user-readable failure message', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-failed-1');
    apiMock.getRecommendationJob.mockResolvedValue(failedJob);
    render(<RecommendationsPage currentProfile={activeProfile} />);

    expect((await screen.findByRole('alert')).textContent).toContain('模型等待超时，请重试。');
  });

  it('continues polling after a transient job status error', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    apiMock.getRecommendationJob
      .mockResolvedValueOnce(queuedJob)
      .mockRejectedValueOnce(new Error('temporary connection reset'))
      .mockResolvedValueOnce(completedJob);
    const navigate = vi.fn();
    render(<RecommendationsPage currentProfile={activeProfile} navigate={navigate} />);

    await waitFor(() => expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 3200));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/reports/7/41'));
  });

  it('stops after three consecutive retryable poll failures', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    apiMock.getRecommendationJob
      .mockResolvedValueOnce(queuedJob)
      .mockRejectedValue(apiError('NETWORK_ERROR', 'temporary connection reset', 0));
    render(<RecommendationsPage currentProfile={activeProfile} />);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(4_500);

    expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(4);
    expect(screen.getByRole('alert').textContent).toContain('temporary connection reset');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(4);
    vi.useRealTimers();
  });

  it('resets the retry budget after a successful poll', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    apiMock.getRecommendationJob
      .mockResolvedValueOnce(queuedJob)
      .mockRejectedValueOnce(apiError('NETWORK_ERROR', 'first outage', 0))
      .mockResolvedValueOnce({ ...queuedJob, phase_percent: 15 })
      .mockRejectedValueOnce(apiError('INTERNAL_ERROR', 'server one', 503))
      .mockRejectedValueOnce(apiError('INTERNAL_ERROR', 'server two', 503))
      .mockRejectedValueOnce(apiError('INTERNAL_ERROR', 'server three', 503))
      .mockRejectedValue(apiError('INTERNAL_ERROR', 'unexpected extra retry', 503));
    render(<RecommendationsPage currentProfile={activeProfile} />);
    await vi.runOnlyPendingTimersAsync();
    await vi.advanceTimersByTimeAsync(9_000);

    expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });

  it('keeps a completed polling history refresh alive through polling cleanup and then navigates', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    apiMock.getRecommendationJob.mockResolvedValueOnce(queuedJob).mockResolvedValueOnce(completedJob);
    let resolveOldHistory!: (result: { items: typeof completedRecommendation[]; page: number; pageSize: number; total: number }) => void;
    let historySignal: AbortSignal | undefined;
    apiMock.listProfileRecommendations.mockImplementation((profileId: number, _query: unknown, signal?: AbortSignal) => {
      if (profileId === 7) {
        historySignal = signal;
        return new Promise((resolve) => { resolveOldHistory = resolve; });
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    });
    const navigate = vi.fn();
    const view = render(<RecommendationsPage currentProfile={activeProfile} navigate={navigate} />);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    expect(apiMock.listProfileRecommendations).toHaveBeenCalledTimes(2);
    expect(historySignal).toBeDefined();

    await Promise.resolve();
    expect(historySignal?.aborted).toBe(false);
    resolveOldHistory({ items: [completedRecommendation], page: 1, pageSize: 25, total: 1 });
    await vi.runOnlyPendingTimersAsync();

    expect(navigate).toHaveBeenCalledWith('/reports/7/41');
    vi.useRealTimers();
  });

  it('aborts a stored completed job history refresh on profile switch and ignores its late result', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    let resolveStoredJob!: (job: RecommendationJob) => void;
    apiMock.getRecommendationJob.mockImplementationOnce(() => new Promise((resolve) => { resolveStoredJob = resolve; }));
    let resolveOldHistory!: (result: { items: typeof completedRecommendation[]; page: number; pageSize: number; total: number }) => void;
    let historySignal: AbortSignal | undefined;
    let holdProfileSevenHistory = false;
    apiMock.listProfileRecommendations.mockImplementation((profileId: number, _query: unknown, signal?: AbortSignal) => {
      if (profileId === 7 && holdProfileSevenHistory) {
        historySignal = signal;
        return new Promise((resolve) => { resolveOldHistory = resolve; });
      }
      return Promise.resolve({ items: [], page: 1, pageSize: 25, total: 0 });
    });
    const navigate = vi.fn();
    const view = render(<RecommendationsPage currentProfile={activeProfile} navigate={navigate} />);
    await waitFor(() => expect(apiMock.listProfileRecommendations).toHaveBeenCalledTimes(1));
    holdProfileSevenHistory = true;
    resolveStoredJob(completedJob);
    await waitFor(() => expect(historySignal).toBeDefined());

    view.rerender(<RecommendationsPage currentProfile={{ ...activeProfile, id: 8, name: 'New profile' }} navigate={navigate} />);
    expect(historySignal?.aborted).toBe(true);
    resolveOldHistory({ items: [completedRecommendation], page: 1, pageSize: 25, total: 1 });
    await Promise.resolve();

    expect(navigate).not.toHaveBeenCalledWith('/reports/7/41');
    expect(screen.queryByText(/用于分析 9 条记录/)).toBeNull();
  });

  it('cancels an active job once and remains stable after cancellation', async () => {
    apiMock.createRecommendationJob.mockResolvedValue(queuedJob);
    apiMock.cancelRecommendationJob.mockResolvedValue({ ...queuedJob, status: 'cancelled' });
    render(<RecommendationsPage currentProfile={activeProfile} />);

    fireEvent.click(screen.getByRole('button', { name: '生成建议' }));
    await screen.findByText('生成前安全提示');
    fireEvent.click(screen.getByRole('checkbox', { name: /确认将所选日期范围的数据传输给模型/ }));
    fireEvent.click(screen.getByRole('button', { name: '确认并生成' }));
    await screen.findByRole('button', { name: '取消生成' });
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));

    await waitFor(() => expect(apiMock.cancelRecommendationJob).toHaveBeenCalledWith(7, 'job-queued-1'));
    expect(screen.queryByRole('button', { name: '取消生成' })).toBeNull();
    expect(apiMock.cancelRecommendationJob).toHaveBeenCalledTimes(1);
  });

  it('stops polling after a permanent 404 job error', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    apiMock.getRecommendationJob
      .mockResolvedValueOnce(queuedJob)
      .mockRejectedValueOnce(apiError('NOT_FOUND', 'Recommendation job not found', 404));
    render(<RecommendationsPage currentProfile={activeProfile} />);
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('alert').textContent).toContain('Recommendation job not found');
    vi.useRealTimers();
  });

  it('aborts a hanging poll on profile switch and ignores its late result', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    let resolveHanging!: (job: RecommendationJob) => void;
    let observedSignal: AbortSignal | undefined;
    apiMock.getRecommendationJob.mockImplementationOnce((_profileId: number, _jobId: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<RecommendationJob>((resolve) => { resolveHanging = resolve; });
    });
    const { rerender } = render(<RecommendationsPage currentProfile={activeProfile} />);
    await waitFor(() => expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(1));

    rerender(<RecommendationsPage currentProfile={{ ...activeProfile, id: 8, name: 'New profile' }} />);
    expect(observedSignal?.aborted).toBe(true);
    resolveHanging(completedJob);
    await Promise.resolve();
    expect(window.localStorage.getItem('recommendation-job-7')).toBe('job-queued-1');
  });

  it('aborts a hanging poll when the page unmounts', async () => {
    window.localStorage.setItem('recommendation-job-7', 'job-queued-1');
    let observedSignal: AbortSignal | undefined;
    apiMock.getRecommendationJob.mockImplementationOnce((_profileId: number, _jobId: string, signal?: AbortSignal) => {
      observedSignal = signal;
      return new Promise<RecommendationJob>(() => undefined);
    });
    const view = render(<RecommendationsPage currentProfile={activeProfile} />);
    await waitFor(() => expect(apiMock.getRecommendationJob).toHaveBeenCalledTimes(1));

    view.unmount();

    expect(observedSignal?.aborted).toBe(true);
  });
});
