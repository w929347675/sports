import { useEffect, useState } from 'react';
import { api, type DailyEntryView } from '../api/client.js';
import { TrendSummary } from '../components/TrendSummary.js';
import { statusLabels } from '../components/StatusSelect.js';
import { summarizeEntries } from '../trends.js';
import { localDate } from './DailyEntryPage.js';

function rangeStart() { const date = new Date(); date.setDate(date.getDate() - 13); return localDate(date); }

export function HistoryPage({ navigate }: { navigate: (path: string) => void }) {
  const [from, setFrom] = useState(rangeStart());
  const [to, setTo] = useState(localDate());
  const [entries, setEntries] = useState<DailyEntryView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  async function load() { setLoaded(false); try { const rows = await api.listDailyEntries(from, to); const details = await Promise.all(rows.map((row) => api.getDailyEntry(row.entry_date))); setEntries(details.filter((item): item is DailyEntryView => item !== null)); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : '读取本地历史失败'); } finally { setLoaded(true); } }
  useEffect(() => { void load(); }, [reload]);
  const summary = summarizeEntries(entries);

  return <main className="page-shell"><div className="page-kicker">历史记录 / 趋势</div><div className="page-title-row"><div><h1>看见一段时间的变化</h1><p>空白日期不会被自动解释为休息日。</p></div><button className="button button--dark" type="button" onClick={() => setReload((value) => value + 1)}>刷新数据</button></div><section className="panel range-panel"><label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label><button className="button button--outline" type="button" onClick={() => setReload((value) => value + 1)}>应用范围</button></section>{error && <div className="read-error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => setReload((value) => value + 1)}>重试读取</button></div>}<TrendSummary summary={summary} /><section className="panel history-list"><div className="section-heading"><div><span className="eyebrow">记录日期</span><h2>{loaded ? `${entries.length} 天有记录` : '读取中...'}</h2></div></div>{loaded && !error && entries.length === 0 && <p className="empty-state">这个范围内还没有记录。选择具体日期开始添加。</p>}{entries.map((entry) => <button type="button" className="history-row" key={entry.entry_date} onClick={() => navigate(`/entry/${entry.entry_date}`)}><span className="history-date">{entry.entry_date}</span><span className="tag">{statusLabels[entry.status]}</span><span>{entry.weights.length} 次体重</span><span>{entry.meals.length} 餐</span><span>{entry.workouts.length} 次训练</span><span className="row-arrow">→</span></button>)}</section></main>;
}
