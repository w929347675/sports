// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { RecommendationJob } from '@fitness-coach/shared';
import { RecommendationProgress } from './RecommendationProgress.js';

const job = {
  job_id: 'job-progress-1',
  profile_id: 7,
  status: 'waiting_model',
  phase_percent: 48,
  received_chars: 1280,
  started_at: '2026-10-13T10:00:00Z',
  updated_at: '2026-10-13T10:00:30Z',
  completed_at: null,
  error_code: null,
  error_message: null,
  error_phase: null,
  request_id: 'request-progress-1',
  recommendation_id: null,
} as unknown as RecommendationJob;

describe('RecommendationProgress', () => {
  it('shows the named stages, estimated progress disclaimer, timing, chars, and cancel action', () => {
    const onCancel = vi.fn();
    render(<RecommendationProgress job={job} onCancel={onCancel} />);

    for (const label of ['准备数据', '发送模型请求', '等待模型分析', '接收模型结果', '校验报告结构', '保存报告']) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText('整理历史摘要')).toBeNull();
    expect(screen.getByText(/阶段估计，不是模型真实进度/)).toBeTruthy();
    expect(screen.getByText(/已接收字符：1,280/)).toBeTruthy();
    expect(screen.getByText(/等待时长/)).toBeTruthy();
    expect(screen.getByText(/最近更新时间/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消生成' }));
    expect(onCancel).toHaveBeenCalledWith();
  });
});
