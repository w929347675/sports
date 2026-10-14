import type { ReportListQuery } from '../api/client.js';

export type ReportFiltersValue = Required<Pick<ReportListQuery, 'status' | 'from' | 'to' | 'risk' | 'hasImages' | 'sort' | 'order'>>;

export function ReportFilters({ filters, onChange }: { filters: ReportFiltersValue; onChange: (filters: ReportFiltersValue) => void }) {
  const update = <K extends keyof ReportFiltersValue>(key: K, value: ReportFiltersValue[K]) => onChange({ ...filters, [key]: value });
  return <section className="panel profile-filters" aria-label="报告筛选">
    <label>状态筛选<select value={filters.status} onChange={(event) => update('status', event.target.value as typeof filters.status)}><option value="">全部状态</option><option value="completed">已完成</option><option value="processing">处理中</option><option value="failed">失败</option></select></label>
    <label>起始日期<input type="date" value={filters.from} onChange={(event) => update('from', event.target.value)} /></label>
    <label>结束日期<input type="date" value={filters.to} onChange={(event) => update('to', event.target.value)} /></label>
    <label>风险筛选<select value={filters.risk} onChange={(event) => update('risk', event.target.value as typeof filters.risk)}><option value="">全部风险</option><option value="true">高风险</option><option value="false">无高风险</option></select></label>
    <label>图片复核<select value={filters.hasImages} onChange={(event) => update('hasImages', event.target.value as typeof filters.hasImages)}><option value="">全部报告</option><option value="true">有图片</option><option value="false">无图片</option></select></label>
    <label>排序<select value={filters.sort} onChange={(event) => update('sort', event.target.value as 'generated_at')}><option value="generated_at">生成时间</option></select></label>
    <label>顺序<select value={filters.order} onChange={(event) => update('order', event.target.value as typeof filters.order)}><option value="desc">降序</option><option value="asc">升序</option></select></label>
  </section>;
}
