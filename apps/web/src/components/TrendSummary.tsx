import type { EntrySummary } from '../trends.js';

export function TrendSummary({ summary }: { summary: EntrySummary }) {
  const cards = [
    ['最新体重', summary.weightLatestKg == null ? '暂无' : `${summary.weightLatestKg} kg`],
    ['体重变化', summary.weightChangeKg == null ? '暂无' : `${summary.weightChangeKg > 0 ? '+' : ''}${summary.weightChangeKg.toFixed(1)} kg`],
    ['训练次数', String(summary.workoutCount)],
    ['训练量', `${summary.trainingVolumeKg.toLocaleString()} kg`],
    ['反馈条数', String(summary.feedbackCount)],
    ['饮食覆盖', `${summary.mealCoveragePercent}%`],
  ];
  const statusLabels: Record<string, string> = { training: '训练', rest: '休息', paused_sick: '暂停/生病', travel: '旅行', custom: '自定义' };
  return <>
    <section className="metric-grid" aria-label="趋势摘要">
      {cards.map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <section className="status-distribution" aria-label="状态分布">{Object.entries(summary.statusDistribution).filter(([, count]) => count > 0).map(([key, count]) => <span className="status-distribution__item" key={key}><i className="status-dot" />{statusLabels[key]} {count} 天</span>)}</section>
  </>;
}
