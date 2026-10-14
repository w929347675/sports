import { useEffect, useRef, useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { api, type Recommendation, type RecommendationJob, type RecommendationPreview, type RecommendationReport } from '../api/client.js';
import { RecommendationError } from '../components/RecommendationError.js';
import { RecommendationProgress } from '../components/RecommendationProgress.js';

const maxConsecutivePollRetries = 3;

function localDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA').format(date);
}

function defaultRange() {
  const start = new Date();
  start.setDate(start.getDate() - 13);
  return { start: localDate(start), end: localDate() };
}

export function reportFrom(recommendation: Recommendation): RecommendationReport | null {
  if (recommendation.report) return recommendation.report;
  try {
    const parsed = JSON.parse(recommendation.structured_report_json) as Partial<RecommendationReport>;
    return parsed && typeof parsed.summary === 'string' && parsed.safety && parsed.trend && parsed.trainingPlan
      ? parsed as RecommendationReport
      : null;
  } catch {
    return null;
  }
}

export function ReportDetails({ report, inputSummary }: { report: RecommendationReport; inputSummary?: Record<string, unknown> }) {
  const highRisk = report.safety.level.toLowerCase() === 'high' || report.safety.level.toLowerCase() === 'critical';
  return <div className="recommendation-report">
    {highRisk && <section className="safety-banner" role="alert"><h2>高风险安全提示</h2><span>{report.safety.banner}</span></section>}
    <section className="panel report-section"><span className="eyebrow">阶段总结</span><h2>这段时间发生了什么</h2><p>{report.summary}</p><div className="report-list"><strong>趋势观察</strong>{report.trend.observations.map((observation) => <span key={observation}>{observation}</span>)}</div>{inputSummary && <div className="coverage-summary"><span>用于分析 {String(inputSummary.recordCount ?? 0)} 条记录</span><span>复核图片 {String(inputSummary.imageCount ?? 0)} 张</span></div>}</section>
    <section className="panel report-section"><div className="section-heading"><div><span className="eyebrow">未来 7 天</span><h2>未来 7 天训练计划</h2></div></div><div className="training-plan">{report.trainingPlan.map((day) => <article className="training-plan-day" key={`${day.day}-${day.focus}`}><span className="day-number">第 {day.day} 天</span><strong>{day.focus}</strong><ul>{day.exercises.map((exercise) => <li key={exercise}>{exercise}</li>)}</ul></article>)}</div></section>
    <div className="report-columns"><section className="panel report-section"><span className="eyebrow">饮食</span><h2>饮食建议</h2><ReportList items={report.dietAdvice} /></section><section className="panel report-section"><span className="eyebrow">恢复</span><h2>恢复</h2><ReportList items={report.recovery} /></section></div>
    <section className="panel report-section"><span className="eyebrow">下一步</span><h2>后续跟进</h2><ReportList items={report.followUps} /></section>
    <section className="panel report-section"><span className="eyebrow">边界</span><h2>不确定性</h2><ReportList items={report.uncertainties} empty="本次报告没有额外列出不确定项。" /></section>
    {!highRisk && <section className="notice"><strong>安全提示</strong><p>{report.safety.banner}</p></section>}
  </div>;
}

function ReportList({ items, empty }: { items: string[]; empty?: string }) {
  if (items.length === 0) return <p className="muted">{empty ?? '暂无内容。'}</p>;
  return <ul className="report-list report-list--bullets">{items.map((item) => <li key={item}>{item}</li>)}</ul>;
}

export function RecommendationsPage({ currentProfile, navigate }: { currentProfile?: ProfileRecord | null; navigate?: (path: string) => void } = {}) {
  const initialRange = defaultRange();
  const [start, setStart] = useState(initialRange.start);
  const [end, setEnd] = useState(initialRange.end);
  const [history, setHistory] = useState<Recommendation[]>([]);
  const [selected, setSelected] = useState<Recommendation | null>(null);
  const [loading, setLoading] = useState(true);
  const [job, setJob] = useState<RecommendationJob | null>(null);
  const [jobAction, setJobAction] = useState<'cancel' | 'retry' | null>(null);
  const [error, setError] = useState('');
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const [explicitReview, setExplicitReview] = useState(false);
  const [preview, setPreview] = useState<RecommendationPreview | null>(null);
  const archived = currentProfile?.status === 'archived';
  const activeProfile = currentProfile?.status === 'active';
  const profileId = currentProfile?.id;
  const jobStorageKey = profileId ? `recommendation-job-${profileId}` : null;
  const activeJob = job !== null && !['completed', 'failed', 'cancelled'].includes(job.status);
  const generating = activeJob || jobAction !== null;
  const loadController = useRef<AbortController | null>(null);
  const profileEpoch = useRef(0);
  const pollController = useRef<AbortController | null>(null);
  const refreshController = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const epoch = ++profileEpoch.current;
    loadController.current?.abort();
    pollController.current?.abort();
    refreshController.current?.abort();
    loadController.current = controller;
    setLoading(true);
    setJob(null);
    const loadHistory = profileId
      ? api.listProfileRecommendations(profileId, { page: 1, pageSize: 25 }, controller.signal).then((result) => result.items)
      : api.listRecommendations();
    void loadHistory.then((recommendations) => {
      if (!active) return;
      setHistory(recommendations);
      const latest = recommendations.find((item) => item.status === 'completed');
      setSelected(latest ?? null);
      setError('');
    }).catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '读取建议历史失败'); }).finally(() => {
      if (active) setLoading(false);
    });

    if (profileId && jobStorageKey) {
      const storedJobId = window.localStorage.getItem(jobStorageKey);
      if (storedJobId) {
         void api.getRecommendationJob(profileId, storedJobId, controller.signal).then((storedJob) => {
          if (!active) return;
          setJob(storedJob);
          if (storedJob.status === 'completed' && storedJob.recommendation_id) {
            window.localStorage.removeItem(jobStorageKey);
            const historyController = new AbortController();
            refreshController.current = historyController;
            void refreshHistory(profileId, historyController.signal, () => active && profileEpoch.current === epoch).then((refreshed) => {
              if (refreshed && active && profileEpoch.current === epoch) navigate?.(`/reports/${profileId}/${storedJob.recommendation_id}`);
            }).catch((cause) => {
              if (active && !isAbortError(cause)) setError(cause instanceof Error ? cause.message : '读取建议历史失败');
            }).finally(() => {
              if (refreshController.current === historyController) refreshController.current = null;
            });
          } else if (storedJob.status === 'cancelled') {
            window.localStorage.removeItem(jobStorageKey);
          }
        }).catch((cause) => {
          if (active) setError(cause instanceof Error ? cause.message : '读取建议任务失败');
        });
      }
    }
     return () => { active = false; controller.abort(); pollController.current?.abort(); refreshController.current?.abort(); };
  }, [profileId, jobStorageKey]);

  useEffect(() => {
    if (!profileId || !jobStorageKey || !job || !activeJob) return;
    let active = true;
    let timer: number | undefined;
    let consecutiveFailures = 0;
    const controller = new AbortController();
    pollController.current = controller;
    const poll = () => {
      void api.getRecommendationJob(profileId, job.job_id, controller.signal).then((nextJob) => {
        if (!active) return;
        consecutiveFailures = 0;
        setJob(nextJob);
        if (['completed', 'failed', 'cancelled'].includes(nextJob.status)) {
          window.localStorage.removeItem(jobStorageKey);
          if (nextJob.status === 'completed' && nextJob.recommendation_id) {
            const historyController = new AbortController();
            refreshController.current = historyController;
            const epoch = profileEpoch.current;
            void refreshHistory(profileId, historyController.signal, () => profileEpoch.current === epoch).then((refreshed) => {
              if (refreshed && profileEpoch.current === epoch) navigate?.(`/reports/${profileId}/${nextJob.recommendation_id}`);
            }).catch((cause) => {
              if (profileEpoch.current === epoch && !isAbortError(cause)) setError(cause instanceof Error ? cause.message : '读取建议历史失败');
            }).finally(() => {
              if (refreshController.current === historyController) refreshController.current = null;
            });
          }
          return;
        }
        timer = window.setTimeout(poll, 1500);
      }).catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : '读取建议任务失败');
        const status = cause && typeof cause === 'object' && 'status' in cause ? Number((cause as { status?: unknown }).status) : 0;
        const code = cause && typeof cause === 'object' && 'code' in cause ? String((cause as { code?: unknown }).code) : '';
        if (status >= 500 || status === 0 || code === 'NETWORK_ERROR') {
          consecutiveFailures += 1;
          if (consecutiveFailures < maxConsecutivePollRetries) timer = window.setTimeout(poll, 1500);
        }
      });
    };
    timer = window.setTimeout(poll, 1500);
    return () => { active = false; controller.abort(); if (pollController.current === controller) pollController.current = null; if (timer !== undefined) window.clearTimeout(timer); };
  }, [activeJob, job?.job_id, jobStorageKey, navigate, profileId]);

  async function refreshHistory(nextProfileId: number, signal?: AbortSignal, isActive: () => boolean = () => true) {
    const result = await api.listProfileRecommendations(nextProfileId, { page: 1, pageSize: 25 }, signal);
    if (signal?.aborted || !isActive()) return false;
    setHistory(result.items);
    const latest = result.items.find((item) => item.status === 'completed');
    setSelected(latest ?? null);
    return true;
  }

  function isAbortError(cause: unknown) {
    return cause instanceof DOMException && cause.name === 'AbortError'
      || cause instanceof Error && cause.name === 'AbortError';
  }

  function requestGeneration() {
    if (!activeProfile) return;
    setError('');
    if (!start || !end || start > end) {
      setError('请选择有效的日期范围。');
      return;
    }
    setTransferConfirmed(false);
    setExplicitReview(false);
    setPreview(null);
    setShowConfirmation(true);
    void api.previewRecommendation({ start, end, explicitReview: false }).then(setPreview).catch((cause) => {
      setShowConfirmation(false);
      setError(cause instanceof Error ? cause.message : '读取分析预览失败');
    });
  }

  function changeImageReview(enabled: boolean) {
    if (!activeProfile) return;
    setExplicitReview(enabled);
    setPreview(null);
    void api.previewRecommendation({ start, end, explicitReview: enabled }).then(setPreview).catch((cause) => {
      setShowConfirmation(false);
      setError(cause instanceof Error ? cause.message : '读取分析预览失败');
    });
  }

  async function generate() {
    if (!activeProfile || !transferConfirmed || generating) return;
    setShowConfirmation(false);
    setError('');
    try {
      if (!profileId || !jobStorageKey) throw new Error('请先选择启用档案。');
      const createdJob = await api.createRecommendationJob(profileId, { start, end, explicitReview });
      setJob(createdJob);
      window.localStorage.setItem(jobStorageKey, createdJob.job_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '生成建议失败，请检查模型连接后重试。');
    }
  }

  async function cancelJob() {
    if (!activeProfile || !profileId || !jobStorageKey || !job || jobAction || !activeJob) return;
    setJobAction('cancel');
    try {
      const cancelled = await api.cancelRecommendationJob(profileId, job.job_id);
      setJob(cancelled);
      if (cancelled.status === 'cancelled') window.localStorage.removeItem(jobStorageKey);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '取消建议任务失败');
    } finally {
      setJobAction(null);
    }
  }

  async function retryJob() {
    if (!activeProfile || !profileId || !jobStorageKey || !job || jobAction || job.status !== 'failed') return;
    setJobAction('retry');
    setError('');
    try {
      const retried = await api.retryRecommendationJob(profileId, job.job_id);
      setJob(retried);
      window.localStorage.setItem(jobStorageKey, retried.job_id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重试建议任务失败');
    } finally {
      setJobAction(null);
    }
  }

  return <main className="page-shell page-shell--narrow">
    <div className="page-kicker">后续建议 / 手动分析</div>
    <div className="page-title-row"><div><h1>阶段建议</h1><p>先选择范围，再主动决定是否把必要的阶段数据传给模型。保存本地记录不会触发分析。</p></div>{generating && <span className="status-pill" role="status">正在生成...</span>}</div>
    {archived && <div className="archive-readonly" role="status"><strong>只读归档</strong><span>归档档案可以查看已有报告，但不能生成新的阶段建议。</span></div>}
     {!archived && <section className="panel recommendation-controls"><div className="section-heading"><div><span className="eyebrow">分析范围</span><h2>选择要回看的日期</h2></div><span className="tag">默认 14 天</span></div><div className="range-panel"><label>开始日期<input aria-label="开始日期" type="date" value={start} onChange={(event) => setStart(event.target.value)} /></label><label>结束日期<input aria-label="结束日期" type="date" value={end} onChange={(event) => setEnd(event.target.value)} /></label><button className="button button--dark" type="button" disabled={!activeProfile || generating} onClick={requestGeneration}>生成建议</button></div><p className="helper">默认发送档案、统计摘要和结构化记录，不发送历史原图。图片复核仅在明确选择时开启。</p></section>}
     {error && <div className="read-error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => setError('')}>关闭</button></div>}
     {job?.status === 'failed' && activeProfile && <RecommendationError job={job} retryDisabled={jobAction !== null} onRetry={() => void retryJob()} />}
     {job && activeJob && activeProfile && <RecommendationProgress job={job} cancelDisabled={jobAction !== null} onCancel={() => void cancelJob()} />}
     {job?.status === 'cancelled' && <div className="notice" role="status"><strong>已取消生成</strong><p>本次建议任务已取消，没有保存新的报告。</p></div>}
    {!archived && showConfirmation && <div className="confirmation-dialog" role="dialog" aria-modal="true" aria-labelledby="transfer-title"><h2 id="transfer-title">确认传输阶段数据</h2><p>生成建议会把所选日期范围的档案、记录摘要和结构化数据发送给已配置的模型服务商。默认不会发送原图。</p>{preview && <div className="preflight-summary" role="status"><strong>{preview.highRisk ? '生成前安全提示' : '生成前检查'}</strong><span>范围内记录 {String(preview.inputSummary.recordCount ?? 0)} 条，复核图片 {preview.imageCount} 张。</span><span>{preview.safety.banner}</span></div>}<label className="confirmation-check"><input type="checkbox" aria-label="允许发送最多 5 张相关图片用于复核" checked={explicitReview} onChange={(event) => changeImageReview(event.target.checked)} />允许发送最多 5 张相关图片用于复核</label><label className="confirmation-check"><input type="checkbox" aria-label="确认将所选日期范围的数据传输给模型" checked={transferConfirmed} onChange={(event) => setTransferConfirmed(event.target.checked)} />确认将所选日期范围的数据传输给模型</label><div className="form-actions"><button className="button button--dark" type="button" disabled={!transferConfirmed || !preview} onClick={() => void generate()}>确认并生成</button><button className="button button--quiet" type="button" onClick={() => setShowConfirmation(false)}>取消</button></div></div>}
    {loading && <p>正在读取报告历史...</p>}
    {!loading && !selected && <section className="panel empty-panel"><span className="empty-icon">14</span><h2>还没有阶段报告</h2><p>{archived ? '此归档档案当前没有可查看的阶段报告。' : '选择日期范围并点击生成建议。模型只会在确认传输后调用。'}</p></section>}
    {!loading && selected && reportFrom(selected) && <ReportDetails report={reportFrom(selected)!} inputSummary={selected.inputSummary} />}
    {!loading && <section className="panel recommendation-history"><div className="section-heading"><div><span className="eyebrow">本机历史</span><h2>报告管理</h2></div><span className="muted">{history.length} 份已保存</span></div><p>报告列表支持按当前档案筛选、查看、导出和删除。</p><button className="button button--outline" type="button" onClick={() => navigate ? navigate('/reports') : (window.history.pushState({}, '', '/reports'), window.dispatchEvent(new PopStateEvent('popstate')))}>查看报告列表</button></section>}
  </main>;
}
