import { useCallback, useEffect, useRef, useState } from 'react';
import type { DailyEntry } from '@fitness-coach/shared';
import { api, entryTimestamp, type DailyEntryView } from '../api/client.js';
import { FeedbackSection } from '../components/FeedbackSection.js';
import { MealSection } from '../components/MealSection.js';
import { SaveStatus } from '../components/SaveStatus.js';
import { SavedRecords } from '../components/SavedRecords.js';
import { StatusSelect } from '../components/StatusSelect.js';
import { WeightSection } from '../components/WeightSection.js';
import { WorkoutSection } from '../components/WorkoutSection.js';

export function localDate(date = new Date()) { return new Intl.DateTimeFormat('en-CA').format(date); }

export function DailyEntryPage({ date = localDate(), navigate }: { date?: string; navigate?: (path: string) => void }) {
  const [entry, setEntry] = useState<DailyEntryView | null>(null);
  const [status, setStatus] = useState<DailyEntry['status']>('training');
  const [statusNote, setStatusNote] = useState('');
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const loadVersion = useRef(0);
  const load = useCallback(async () => { const version = ++loadVersion.current; const saved = await api.getDailyEntry(date); if (version !== loadVersion.current) return; setEntry(saved); if (saved) { setStatus(saved.status); setStatusNote(saved.status_note ?? ''); } }, [date]);
  useEffect(() => { void load().catch((cause) => { setError(cause instanceof Error ? cause.message : '读取日记录失败'); setSaveState('error'); }); }, [load]);

  async function saveStatus() {
    setSaveState('saving');
    try { await api.saveDailyEntry(date, { status, status_note: statusNote }); await load(); setSaveState('saved'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '保存当天状态失败'); setSaveState('error'); }
  }

  return <main className="page-shell"><div className="page-kicker">日记录 / {date}</div><div className="page-title-row"><div><h1>记录今天的状态</h1><p>先记录发生过什么，再决定是否需要进行任何分析。</p></div><SaveStatus status={saveState} error={error} /></div>
    <section className="panel status-panel"><StatusSelect value={status} onChange={setStatus} /><label>状态备注<input value={statusNote} onChange={(event) => setStatusNote(event.target.value)} placeholder="休息原因、旅行安排..." /></label><button className="button button--dark" type="button" disabled={saveState === 'saving'} onClick={saveStatus}>保存当天状态</button></section>
    <div className="record-stack">{!entry && <p className="entry-gate">请先保存当天状态，再添加体重、餐次、训练或反馈。</p>}<WeightSection date={date} disabled={!entry} onSaved={() => void load()} /><MealSection date={date} disabled={!entry} onSaved={() => void load()} /><WorkoutSection date={date} disabled={!entry} onSaved={() => void load()} /><FeedbackSection date={date} disabled={!entry} onSaved={() => void load()} /></div>
    {entry && <SavedRecords date={date} entry={entry} onChanged={() => void load()} navigate={navigate} />}
  </main>;
}
