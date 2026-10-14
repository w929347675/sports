import { useEffect, useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { api, type Recommendation, type ReportListQuery } from '../api/client.js';
import { ReportDeleteDialog } from '../components/ReportDeleteDialog.js';
import { ReportFilters } from '../components/ReportFilters.js';
import { ReportList } from '../components/ReportList.js';

const defaultFilters: Required<Pick<ReportListQuery, 'status' | 'from' | 'to' | 'risk' | 'hasImages' | 'sort' | 'order'>> = {
  status: '', from: '', to: '', risk: '', hasImages: '', sort: 'generated_at', order: 'desc',
};

export function ReportsPage({ currentProfile, profileId, navigate }: { currentProfile: ProfileRecord | null; profileId?: number; navigate: (path: string) => void }) {
  const [filters, setFilters] = useState(defaultFilters);
  const [page, setPage] = useState(1);
  const [pagination, setPagination] = useState({ total: 0, page: 1, pageSize: 25 });
  const [reports, setReports] = useState<Recommendation[]>([]);
  const [scopedProfile, setScopedProfile] = useState<Pick<ProfileRecord, 'id' | 'name' | 'status'> | null>(profileId ? null : currentProfile);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deleting, setDeleting] = useState<Recommendation[] | null>(null);
  const [reload, setReload] = useState(0);
  const [loading, setLoading] = useState(Boolean(profileId ?? currentProfile));
  const [error, setError] = useState('');
  const scopeId = profileId ?? currentProfile?.id;
  const archived = scopedProfile?.status === 'archived';

  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [scopeId]);

  useEffect(() => {
    if (!scopeId) {
      setLoading(false);
      setScopedProfile(null);
      setReports([]);
      setPagination({ total: 0, page: 1, pageSize: 25 });
      setDeleting(null);
      return;
    }
    let active = true;
    setLoading(true);
    setError('');
    setReports([]);
    setSelected(new Set());
    setPagination({ total: 0, page: 1, pageSize: 25 });
    setDeleting(null);
    if (profileId) setScopedProfile(null);
    const profileRequest = profileId ? api.getProfileById(profileId) : Promise.resolve(currentProfile);
    void Promise.all([profileRequest, api.listProfileRecommendations(scopeId, { ...filters, page })]).then(([nextProfile, result]) => {
      if (!active) return;
      setScopedProfile(nextProfile);
      setReports(result.items);
      setPagination({ total: result.total, page: result.page, pageSize: result.pageSize });
      setSelected((current) => new Set([...current].filter((id) => result.items.some((report) => report.id === id))));
    }).catch((cause) => {
      if (!active) return;
      setReports([]);
      setSelected(new Set());
      setPagination({ total: 0, page: 1, pageSize: 25 });
      setDeleting(null);
      setScopedProfile(null);
      setError(cause instanceof Error ? cause.message : '报告列表读取失败');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [scopeId, profileId, currentProfile, filters.status, filters.from, filters.to, filters.risk, filters.hasImages, filters.sort, filters.order, page, reload]);

  async function remove() {
    if (!scopeId || !deleting) return;
    const shouldMoveToPreviousPage = page > 1 && deleting.length === reports.length;
    try {
      if (deleting.length === 1) await api.deleteProfileRecommendation(scopeId, deleting[0].id);
      else await api.bulkDeleteProfileRecommendations(scopeId, deleting.map(({ id }) => id));
      setDeleting(null);
      setSelected(new Set());
      if (shouldMoveToPreviousPage) setPage((value) => value - 1);
      setReload((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '报告删除失败');
    }
  }

  const selectedReports = reports.filter(({ id }) => selected.has(id));
  const hasPreviousPage = pagination.page > 1;
  const hasNextPage = pagination.page * pagination.pageSize < pagination.total;
  const changePage = (nextPage: number) => {
    setSelected(new Set());
    setPage(nextPage);
  };
  return <main className="page-shell profiles-page">
    <div className="page-kicker">报告管理 / 当前档案隔离</div>
    <div className="page-title-row"><div><h1>阶段报告</h1><p>查看{scopedProfile?.name ? `「${scopedProfile.name}」` : '当前档案'}保存的报告。每份报告都保留生成时的范围、模型和输入统计。</p></div><div className="page-actions">{!profileId && !archived && <button className="button button--outline" type="button" onClick={() => navigate('/recommendations')}>生成新报告</button>}{!archived && <button className="button button--danger" type="button" disabled={selectedReports.length === 0} onClick={() => setDeleting(selectedReports)}>删除所选报告</button>}</div></div>
    {archived && <div className="archive-readonly" role="status"><strong>只读归档</strong><span>归档档案的报告可以查看和导出，但不能删除或重新生成。</span></div>}
    {!scopeId && <div className="archive-readonly" role="status"><strong>未选择档案</strong><span>请选择一个档案后查看其报告。</span></div>}
    {scopedProfile && <ReportFilters filters={filters} onChange={(nextFilters) => { setSelected(new Set()); setPage(1); setFilters(nextFilters); }} />}
    {error && <div className="read-error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => setReload((value) => value + 1)}>重试读取</button></div>}
    {loading && <p>正在读取报告...</p>}
    {!loading && <ReportList reports={reports} selected={selected} canDelete={Boolean(scopeId && !archived)} onSelected={(id, checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} onSelectAll={(checked) => setSelected(checked ? new Set(reports.map(({ id }) => id)) : new Set())} onOpen={(report) => navigate(`/reports/${scopeId ?? report.profile_id}/${report.id}`)} onDelete={(report) => setDeleting([report])} />}
    {!loading && (hasPreviousPage || hasNextPage) && <div className="form-actions">{hasPreviousPage && <button className="button button--quiet" type="button" onClick={() => changePage(pagination.page - 1)}>上一页</button>}{hasNextPage && <button className="button button--outline" type="button" onClick={() => changePage(pagination.page + 1)}>下一页</button>}</div>}
    {deleting && <ReportDeleteDialog reports={deleting} onCancel={() => setDeleting(null)} onConfirm={() => void remove()} />}
  </main>;
}
