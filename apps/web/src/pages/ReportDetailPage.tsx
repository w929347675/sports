import { useEffect, useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { api, type ManagedProfileDetail, type Recommendation } from '../api/client.js';
import { ReportDeleteDialog } from '../components/ReportDeleteDialog.js';
import { ReportDetails, reportFrom } from './RecommendationsPage.js';

export function ReportDetailPage({ profileId, reportId, currentProfile, navigate }: { profileId: number; reportId: number; currentProfile: ProfileRecord | null; navigate: (path: string) => void }) {
  const [report, setReport] = useState<Recommendation | null>(null);
  const [profile, setProfile] = useState<Pick<ManagedProfileDetail, 'name' | 'status'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState<'markdown' | 'json' | null>(null);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setReport(null);
    setProfile(null);
    setShowDeleteDialog(false);
    setError('');
    void Promise.all([api.getProfileRecommendation(profileId, reportId), api.getProfileById(profileId)]).then(([nextReport, nextProfile]) => {
      if (!active) return;
      setReport(nextReport);
      setProfile(nextProfile);
      setError('');
    }).catch((cause) => {
      if (!active) return;
      setReport(null);
      setProfile(null);
      setError(cause instanceof Error ? cause.message : '报告读取失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [profileId, reportId]);

  async function exportReport(format: 'markdown' | 'json') {
    setExporting(format);
    try {
      await api.downloadRecommendationExport(profileId, reportId, format);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '报告导出失败');
    } finally {
      setExporting(null);
    }
  }

  async function deleteReport() {
    try {
      setError('');
      await api.deleteProfileRecommendation(profileId, reportId);
      setShowDeleteDialog(false);
      navigate(`/reports/${profileId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '报告删除失败');
    }
  }

  const viewedProfile = profile ?? (currentProfile?.id === profileId ? currentProfile : null);
  const archived = viewedProfile?.status === 'archived';
  const active = viewedProfile?.status === 'active';
  const inputSummary = report?.inputSummary ?? (() => { try { return report ? JSON.parse(report.input_summary_json) as Record<string, unknown> : undefined; } catch { return undefined; } })();
  const inputCount = report?.input_record_count || Number(inputSummary?.recordCount ?? 0);
  const imageCount = report?.image_review_count || Number(inputSummary?.imageCount ?? 0);
  const listPath = `/reports/${profileId}`;
  return <main className="page-shell page-shell--narrow">
    <div className="page-title-row"><div><div className="page-kicker">报告详情 / {archived ? '只读归档' : '当前档案'}</div><h1>{viewedProfile?.name ?? report?.profile?.name ?? '报告详情'}</h1><p>{report ? `${report.range_start} 至 ${report.range_end} · ${report.model_name}` : '读取保存的阶段报告'}</p></div><div className="page-actions"><button className="button button--quiet" type="button" onClick={() => navigate(listPath)}>返回报告列表</button>{report && <><button className="button button--outline" type="button" disabled={exporting !== null} onClick={() => void exportReport('markdown')}>导出 Markdown</button><button className="button button--outline" type="button" disabled={exporting !== null} onClick={() => void exportReport('json')}>导出 JSON</button></>}{active && <button className="button button--danger" type="button" onClick={() => setShowDeleteDialog(true)}>删除报告</button>}{profile?.status === 'active' && currentProfile?.id === profileId && <button className="button button--dark" type="button" onClick={() => navigate('/recommendations')}>重新生成</button>}</div></div>
    {archived && <div className="archive-readonly" role="status"><strong>只读归档</strong><span>该报告可以查看和导出；删除和重新生成控制已禁用。</span></div>}
    {error && <div className="read-error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => navigate(listPath)}>返回列表</button></div>}
    {loading && <p>正在读取报告...</p>}
    {!loading && report && <><section className="panel profile-overview"><dl><div><dt>报告范围</dt><dd>{report.range_start} 至 {report.range_end}</dd></div><div><dt>生成时间</dt><dd>{report.generated_at ? new Date(report.generated_at).toLocaleString() : '暂无'}</dd></div><div><dt>模型</dt><dd>{report.model_name}</dd></div><div><dt>输入统计</dt><dd>{inputCount} 条记录</dd></div><div><dt>图片复核</dt><dd>{imageCount} 张</dd></div><div><dt>状态</dt><dd>{report.status}</dd></div></dl></section>{reportFrom(report) ? <ReportDetails report={reportFrom(report)!} inputSummary={inputSummary} /> : <section className="panel report-section"><h2>报告内容</h2><pre>{report.report_markdown}</pre></section>}</>}
    {showDeleteDialog && <ReportDeleteDialog reports={report ? [report] : []} onCancel={() => setShowDeleteDialog(false)} onConfirm={() => void deleteReport()} />}
  </main>;
}
