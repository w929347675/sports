import { useRef, useState } from 'react';
import { api, entryTimestamp } from '../api/client.js';
import { SaveStatus } from './SaveStatus.js';

export function MealSection({ date, disabled = false, onSaved }: { date: string; disabled?: boolean; onSaved: () => void }) {
  const [mealType, setMealType] = useState('breakfast');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  async function save() {
    setStatus('saving');
    try {
      const meal = await api.createMeal(date, { eaten_at: entryTimestamp(date), meal_type: mealType, notes, recognition_status: 'unrecognized' });
      for (const file of files) await api.uploadMealImage(meal.id, file);
      setNotes('');
      setFiles([]);
      if (fileRef.current) fileRef.current.value = '';
      setStatus('saved');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存餐次失败');
      setStatus('error');
    }
  }

  return <section className="record-section">
    <div className="section-heading"><div><span className="eyebrow">02 / 饮食记录</span><h2>新增餐次</h2></div><SaveStatus status={status} error={error} /></div>
    <div className="form-grid form-grid--three">
      <label>餐次类型<select aria-label="餐次类型" value={mealType} onChange={(event) => setMealType(event.target.value)}><option value="breakfast">早餐</option><option value="lunch">午餐</option><option value="dinner">晚餐</option><option value="snack">加餐</option></select></label>
      <label>餐次备注<input aria-label="餐次备注" value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="食材、份量或感受" /></label>
      <label>本地图片<input ref={fileRef} type="file" multiple accept="image/png,image/jpeg,image/webp,image/gif" onChange={(event) => setFiles(Array.from(event.target.files ?? []))} /></label>
    </div>
    <button className="button button--dark" type="button" disabled={disabled || status === 'saving'} onClick={save}>保存餐次</button>
    {files.length > 0 && <p className="helper">已选择 {files.length} 张图片</p>}
    <p className="helper">图片只保存到本机；保存餐次不会调用模型。识别功能将在后续阶段由用户主动触发。</p>
  </section>;
}
