import type { ProfileListFilters } from '../api/client.js';

export function ProfileFilters({ filters, onChange }: { filters: Required<ProfileListFilters>; onChange: (filters: Required<ProfileListFilters>) => void }) {
  const update = <K extends keyof Required<ProfileListFilters>>(key: K, value: Required<ProfileListFilters>[K]) => onChange({ ...filters, [key]: value });
  return <section className="panel profile-filters" aria-label="档案筛选">
    <label>状态筛选<select value={filters.status} onChange={(event) => update('status', event.target.value as Required<ProfileListFilters>['status'])}><option value="active">仅启用</option><option value="archived">仅归档</option><option value="all">全部</option></select></label>
    <label>时间字段<select value={filters.timeField} onChange={(event) => { const field = event.target.value as Required<ProfileListFilters>['timeField']; onChange({ ...filters, timeField: field, sort: field }); }}><option value="created_at">创建时间</option><option value="updated_at">更新时间</option><option value="last_entry_at">最近记录</option><option value="last_recommendation_at">最近报告</option></select></label>
    <label>起始日期<input type="date" value={filters.from} onChange={(event) => update('from', event.target.value)} /></label>
    <label>结束日期<input type="date" value={filters.to} onChange={(event) => update('to', event.target.value)} /></label>
    <label>排序<select value={filters.order} onChange={(event) => update('order', event.target.value as 'asc' | 'desc')}><option value="desc">降序</option><option value="asc">升序</option></select></label>
  </section>;
}
