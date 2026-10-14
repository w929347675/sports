import { useEffect, useState } from 'react';
import { api, type DailyEntryView } from '../api/client.js';
import { TrendSummary } from '../components/TrendSummary.js';
import { summarizeEntries } from '../trends.js';
import { localDate } from './DailyEntryPage.js';

export function WorkbenchPage({ navigate }: { navigate: (path: string) => void }) {
  const today = localDate();
  const [summary, setSummary] = useState(summarizeEntries([]));
  const [todayEntry, setTodayEntry] = useState<DailyEntryView | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void (async () => {
      const entry = await api.getDailyEntry(today);
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - 13);
      const rows = await api.listDailyEntries(localDate(start), today);
      const details = await Promise.all(rows.map((row) => api.getDailyEntry(row.entry_date)));
      if (active) { setTodayEntry(entry); setSummary(summarizeEntries(details.filter((item): item is DailyEntryView => item !== null))); setError(''); }
    })().catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : '读取本地记录失败'); });
    return () => { active = false; };
  }, [today, reload]);

  return <main className="page-shell"><div className="workbench-hero"><div><div className="page-kicker">今日工作台 / {today}</div><h1>今日工作台</h1><p>记录是第一步。分析和建议永远由你主动决定。</p></div><button className="button button--dark button--large" type="button" onClick={() => navigate(`/entry/${today}`)}>+ 添加今日记录</button></div>{error && <div className="read-error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => setReload((value) => value + 1)}>重试读取</button></div>}<TrendSummary summary={summary} /><div className="workbench-grid"><section className="panel action-panel"><div className="section-heading"><div><span className="eyebrow">今天</span><h2>{todayEntry ? '记录已开始' : '还没有今天的记录'}</h2></div><span className="status-pill">本地保存</span></div><p>{todayEntry ? '可以继续补充体重、餐次、训练和身体反馈。' : '从状态、体重或餐次开始，保存按钮只写入本机。'}</p><button className="button button--outline" type="button" onClick={() => navigate(`/entry/${today}`)}>打开日记录</button></section><section className="panel pending-panel"><div className="section-heading"><div><span className="eyebrow">需要留意</span><h2>未识别饮食</h2></div><span className="count-badge">{summary.pendingMealCount}</span></div><p>{summary.pendingMealCount ? '这些餐次已保存，但尚未进行任何识别。' : '暂无待识别餐次。'}</p><span className="muted">不会自动调用模型</span></section><section className="panel report-panel"><div className="section-heading"><div><span className="eyebrow">阶段建议</span><h2>最近报告</h2></div></div><p>建议报告会在后续阶段由你主动生成，目前不会自动分析。</p><button className="button button--quiet" type="button" onClick={() => navigate('/recommendations')}>查看建议入口</button></section></div></main>;
}
