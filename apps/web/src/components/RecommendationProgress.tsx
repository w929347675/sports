import type { RecommendationJob } from '@fitness-coach/shared';

const stages: Array<{ status: RecommendationJob['status']; label: string }> = [
  { status: 'preparing', label: '准备数据' },
  { status: 'sending', label: '发送模型请求' },
  { status: 'waiting_model', label: '等待模型分析' },
  { status: 'receiving', label: '接收模型结果' },
  { status: 'parsing', label: '校验报告结构' },
  { status: 'saving', label: '保存报告' },
];

const stageOrder: RecommendationJob['status'][] = ['queued', 'preparing', 'sending', 'waiting_model', 'receiving', 'parsing', 'saving', 'completed'];

function stageIndex(status: RecommendationJob['status']) {
  const index = stageOrder.indexOf(status);
  return index < 0 ? 0 : index;
}

function elapsed(startedAt: string | null) {
  if (!startedAt) return '尚未开始';
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function RecommendationProgress({ job, onCancel, cancelDisabled = false }: { job: RecommendationJob; onCancel: () => void; cancelDisabled?: boolean }) {
  const currentIndex = stageIndex(job.status);
  const currentLabel = job.status === 'queued' ? '准备数据' : stages.find((stage) => stage.status === job.status)?.label ?? '准备数据';
  return <section className="panel" aria-label="建议生成进度">
    <div className="section-heading"><div><span className="eyebrow">异步生成</span><h2>{currentLabel}</h2></div><span className="status-pill" role="status">{job.status}</span></div>
    <p>任务 ID：<code>{job.job_id}</code></p>
    <p className="muted">阶段估计，不是模型真实进度</p>
    <progress aria-label="阶段估计进度" value={job.phase_percent} max={100}>{job.phase_percent}%</progress>
    <p>{job.phase_percent}% · 已接收字符：{job.received_chars.toLocaleString('en-US')}</p>
    <p className="muted">等待时长：{elapsed(job.started_at)} · 最近更新时间：{new Date(job.updated_at).toLocaleString()}</p>
    <ol>{stages.map((stage, index) => <li key={stage.label} aria-current={index === Math.min(Math.max(currentIndex - 1, 0), stages.length - 1) ? 'step' : undefined}>{stage.label}</li>)}</ol>
    {['queued', 'preparing', 'sending', 'waiting_model', 'receiving'].includes(job.status) && <button className="button button--quiet" type="button" disabled={cancelDisabled} onClick={() => onCancel()}>取消生成</button>}
  </section>;
}
