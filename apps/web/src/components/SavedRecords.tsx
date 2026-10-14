import { useRef, useState } from 'react';
import type { DailyEntryView } from '../api/client.js';
import { api } from '../api/client.js';

const mealTypeLabels: Record<string, string> = { breakfast: '早餐', lunch: '午餐', dinner: '晚餐', snack: '加餐' };

type SavedRecordsProps = {
  date: string;
  entry: DailyEntryView;
  onChanged: () => void;
  navigate?: (path: string) => void;
};

export function SavedRecords({ date, entry, onChanged, navigate }: SavedRecordsProps) {
  const [error, setError] = useState('');
  const [selectedMealIds, setSelectedMealIds] = useState<number[]>([]);
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchMessage, setBatchMessage] = useState('');
  const [batchResults, setBatchResults] = useState<string[]>([]);
  function reportError(cause: unknown) { setError(cause instanceof Error ? cause.message : '本地记录操作失败'); }
  async function recognizeBatch() {
    if (!selectedMealIds.length) return;
    setBatchBusy(true);
    setBatchMessage('');
    setBatchResults([]);
    try {
      const results = await api.recognizeMealsBatch(selectedMealIds);
      setBatchResults(results.map((result) => {
        const meal = entry.meals.find((item) => item.id === result.mealId);
        const label = meal?.notes || mealTypeLabels[meal?.meal_type ?? ''] || `餐次 ${result.mealId}`;
        return result.status === 'failed' ? `${label}：识别失败：${result.error.message}` : `${label}：识别成功`;
      }));
      setBatchMessage('识别完成');
      setSelectedMealIds([]);
      onChanged();
    } catch (cause) { reportError(cause); }
    finally { setBatchBusy(false); }
  }
  return <section className="panel saved-records">
    <div className="section-heading"><div><span className="eyebrow">已保存</span><h2>这一天的记录</h2></div><span className="muted">所有内容来自本地 API</span></div>
    {error && <p className="save-status save-status--error" role="alert">{error}</p>}
    <div className="saved-record-list">
      <div className="saved-record-group"><strong>体重</strong>{entry.weights.length ? entry.weights.map((item) => <EditableWeight key={item.id} date={date} item={item} onChanged={onChanged} onError={reportError} />) : <p className="muted">暂无记录</p>}</div>
      <div className="saved-record-group"><div className="saved-group-heading"><strong>餐次</strong>{entry.meals.some((item) => ['unrecognized', 'needs_review', 'failed'].includes(item.recognition_status)) && <button className="button button--outline" type="button" disabled={batchBusy || !selectedMealIds.length} onClick={() => void recognizeBatch()}>识别选中餐次</button>}</div>{batchMessage && <p className="save-status save-status--success">{batchMessage}</p>}{batchResults.map((message) => <p className={`save-status ${message.includes('识别失败') ? 'save-status--error' : 'save-status--success'}`} role={message.includes('识别失败') ? 'alert' : undefined} key={message}>{message}</p>)}{entry.meals.length ? entry.meals.map((item) => <EditableMeal key={item.id} date={date} item={item} onChanged={onChanged} onError={reportError} navigate={navigate} selectable={['unrecognized', 'needs_review', 'failed'].includes(item.recognition_status)} selected={selectedMealIds.includes(item.id)} onSelect={(checked) => setSelectedMealIds((current) => checked ? [...current, item.id] : current.filter((id) => id !== item.id))} />) : <p className="muted">暂无记录</p>}</div>
      <div className="saved-record-group"><strong>训练</strong>{entry.workouts.length ? entry.workouts.map((item) => <EditableWorkout key={item.id} date={date} item={item} onChanged={onChanged} onError={reportError} />) : <p className="muted">暂无记录</p>}</div>
      <div className="saved-record-group"><strong>身体反馈</strong>{entry.feedback.length ? entry.feedback.map((item) => <EditableFeedback key={item.id} date={date} item={item} onChanged={onChanged} onError={reportError} />) : <p className="muted">暂无记录</p>}</div>
    </div>
  </section>;
}

function RecordActions({ label, editing, onEdit, onDelete }: { label: string; editing: boolean; onEdit: () => void; onDelete: () => void }) {
  if (editing) return null;
  return <span className="record-actions"><button className="button button--quiet" type="button" aria-label={`编辑${label}`} onClick={onEdit}>编辑</button><button className="button button--quiet button--danger" type="button" aria-label={`删除${label}`} onClick={onDelete}>删除</button></span>;
}

function EditableWeight({ date, item, onChanged, onError }: { date: string; item: DailyEntryView['weights'][number]; onChanged: () => void; onError: (error: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(item.weight_kg));
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.patchWeight(date, { id: item.id, weight_kg: Number(value) }); setEditing(false); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await api.deleteWeight(date, item.id); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <div className="saved-record-item">{editing ? <div className="inline-edit"><label>编辑体重<input aria-label="编辑体重" type="number" min="0.1" step="0.1" value={value} onChange={(event) => setValue(event.target.value)} /></label><button className="button button--quiet" type="button" disabled={busy} onClick={save}>保存体重修改</button><button className="button button--quiet" type="button" onClick={() => setEditing(false)}>取消</button></div> : <><span>{item.weight_kg} kg <span className="muted">{item.note}</span></span><RecordActions label="体重" editing={editing} onEdit={() => setEditing(true)} onDelete={() => void remove()} /></>}</div>;
}

function EditableMeal({ date, item, onChanged, onError, navigate, selectable, selected, onSelect }: { date: string; item: DailyEntryView['meals'][number]; onChanged: () => void; onError: (error: unknown) => void; navigate?: (path: string) => void; selectable: boolean; selected: boolean; onSelect: (checked: boolean) => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(item.notes ?? '');
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.patchMeal(date, { id: item.id, notes }); setEditing(false); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await api.deleteMeal(date, item.id); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  async function upload() { const file = fileRef.current?.files?.[0]; if (!file) return; setBusy(true); try { await api.uploadMealImage(item.id, file); if (fileRef.current) fileRef.current.value = ''; onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <div className="saved-record-item saved-record-item--stacked">{editing ? <div className="inline-edit"><label>编辑餐次备注<input aria-label={`编辑${item.meal_type}备注`} value={notes} onChange={(event) => setNotes(event.target.value)} /></label><button className="button button--quiet" type="button" disabled={busy} onClick={save}>保存餐次修改</button><button className="button button--quiet" type="button" onClick={() => setEditing(false)}>取消</button></div> : <><div className="record-line"><span className="meal-record-title">{selectable && <input aria-label={`选择${mealTypeLabels[item.meal_type] ?? item.meal_type}进行识别`} type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} />}<button className="meal-link" type="button" onClick={() => navigate?.(`/entry/${date}?meal=${item.id}`)}>{item.notes || item.meal_type}</button> <span className="tag">{item.recognition_status === 'unrecognized' ? '待识别' : item.recognition_status === 'needs_review' ? '待确认' : item.recognition_status === 'processing' ? '识别中' : item.recognition_status === 'failed' ? '识别失败' : '已确认'}</span></span><RecordActions label="餐次" editing={editing} onEdit={() => setEditing(true)} onDelete={() => void remove()} /></div><div className="meal-images">{item.images.map((image) => image.warning ? <span className="muted" key={image.id}>图片缺失：{image.warning}</span> : <img key={image.id} src={`/api/images/${image.id}`} alt="本地餐次图片" />)}<label className="image-upload">添加本地图片<input aria-label={`为${item.notes || item.meal_type}添加本地图片`} ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={() => void upload()} /></label></div></>}</div>;
}

function EditableWorkout({ date, item, onChanged, onError }: { date: string; item: DailyEntryView['workouts'][number]; onChanged: () => void; onError: (error: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [type, setType] = useState(item.workout_type);
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.patchWorkout(date, { id: item.id, workout_type: type }); setEditing(false); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await api.deleteWorkout(date, item.id); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <div className="saved-record-item">{editing ? <div className="inline-edit"><label>编辑训练类型<input aria-label="编辑训练类型" value={type} onChange={(event) => setType(event.target.value)} /></label><button className="button button--quiet" type="button" disabled={busy} onClick={save}>保存训练修改</button><button className="button button--quiet" type="button" onClick={() => setEditing(false)}>取消</button></div> : <><span>{item.workout_type} <span className="muted">{item.exercises.length} 个动作</span></span><RecordActions label="训练" editing={editing} onEdit={() => setEditing(true)} onDelete={() => void remove()} /></>}</div>;
}

function EditableFeedback({ date, item, onChanged, onError }: { date: string; item: DailyEntryView['feedback'][number]; onChanged: () => void; onError: (error: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [severity, setSeverity] = useState(String(item.severity));
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.patchFeedback(date, { id: item.id, severity: Number(severity) }); setEditing(false); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  async function remove() { setBusy(true); try { await api.deleteFeedback(date, item.id); onChanged(); } catch (error) { onError(error); } finally { setBusy(false); } }
  return <div className="saved-record-item">{editing ? <div className="inline-edit"><label>编辑程度<input aria-label="编辑反馈程度" type="number" min="0" max="10" step="1" value={severity} onChange={(event) => setSeverity(event.target.value)} /></label><button className="button button--quiet" type="button" disabled={busy} onClick={save}>保存反馈修改</button><button className="button button--quiet" type="button" onClick={() => setEditing(false)}>取消</button></div> : <><span>{item.body_part} / {item.severity} <span className="muted">{item.description}</span></span><RecordActions label="反馈" editing={editing} onEdit={() => setEditing(true)} onDelete={() => void remove()} /></>}</div>;
}
