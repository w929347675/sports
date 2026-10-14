import type { Recommendation } from '../api/client.js';

const statusLabels: Record<Recommendation['status'], string> = { processing: '处理中', completed: '已完成', failed: '失败' };

function isHighRisk(report: Recommendation) {
  const level = report.report?.safety.level?.toLowerCase();
  return level === 'high' || level === 'critical' || report.inputSummary?.highRisk === true;
}

function inputCount(report: Recommendation) {
  return report.input_record_count || Number(report.inputSummary?.recordCount ?? 0);
}

function imageCount(report: Recommendation) {
  return report.image_review_count || Number(report.inputSummary?.imageCount ?? 0);
}

export function ReportList({ reports, selected, canDelete, onSelected, onSelectAll, onOpen, onDelete }: {
  reports: Recommendation[];
  selected: Set<number>;
  canDelete: boolean;
  onSelected: (id: number, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onOpen: (report: Recommendation) => void;
  onDelete: (report: Recommendation) => void;
}) {
  if (reports.length === 0) return <section className="panel empty-panel"><span className="empty-icon">NO REPORTS</span><h2>还没有符合条件的报告</h2><p>调整筛选条件，或前往建议入口生成新的阶段报告。</p></section>;
  return <section className="panel recommendation-history" aria-label="报告列表">
    {canDelete && <label className="profile-select-all"><input type="checkbox" aria-label="全选报告" checked={reports.every(({ id }) => selected.has(id))} onChange={(event) => onSelectAll(event.target.checked)} />选择当前结果中的全部报告</label>}
    {reports.map((report) => <article className="profile-card" key={report.id}>
      {canDelete && <label className="profile-card__check"><input type="checkbox" aria-label={`选择报告 ${report.id}`} checked={selected.has(report.id)} onChange={(event) => onSelected(report.id, event.target.checked)} /></label>}
      <button className="report-list__open profile-card__main" type="button" onClick={() => onOpen(report)}>
        <span className="profile-card__title"><strong>{report.range_start} 至 {report.range_end}</strong><span className="tag">{statusLabels[report.status]}</span>{isHighRisk(report) ? <span className="risk-flag">高风险</span> : <span className="muted">无高风险</span>}</span>
        <span className="profile-card__metrics"><span>{report.model_name}</span><span>{inputCount(report)} 条输入</span><span>复核图片 {imageCount(report)} 张</span></span>
        <span className="profile-card__flags"><span>生成于 {report.generated_at ? new Date(report.generated_at).toLocaleString() : '未生成'}</span><span className="row-arrow">→</span></span>
      </button>
      {canDelete && <div className="profile-card__actions"><button className="button button--quiet" type="button" aria-label={`删除报告 ${report.id}`} onClick={() => onDelete(report)}>删除</button></div>}
    </article>)}
  </section>;
}
