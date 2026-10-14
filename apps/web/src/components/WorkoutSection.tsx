import { useState } from 'react';
import { api, entryTimestamp } from '../api/client.js';
import { SaveStatus } from './SaveStatus.js';

type ExerciseDraft = { name: string; weight: string; weightUnit: string; sets: string; repetitions: string; notes: string };

export function WorkoutSection({ date, disabled = false, onSaved }: { date: string; disabled?: boolean; onSaved: () => void }) {
  const [type, setType] = useState('');
  const [duration, setDuration] = useState('');
  const [exercises, setExercises] = useState<ExerciseDraft[]>([{ name: '', weight: '', weightUnit: 'kg', sets: '', repetitions: '', notes: '' }]);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  async function save() {
    setStatus('saving');
    try {
      const workout = await api.createWorkout(date, { started_at: entryTimestamp(date), workout_type: type || '未命名训练', duration_minutes: duration ? Number(duration) : undefined, notes: '' });
      await Promise.all(exercises.filter((item) => item.name.trim()).map((item) => api.createExercise(workout.id, { name: item.name, weight: item.weight ? Number(item.weight) : undefined, weight_unit: item.weightUnit, sets: Number(item.sets) || 1, repetitions: Number(item.repetitions) || 1, completed: true, notes: item.notes })));
      setType('');
      setDuration('');
      setExercises([{ name: '', weight: '', weightUnit: 'kg', sets: '', repetitions: '', notes: '' }]);
      setStatus('saved');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存训练失败');
      setStatus('error');
    }
  }

  return <section className="record-section">
    <div className="section-heading"><div><span className="eyebrow">03 / 训练记录</span><h2>新增训练</h2></div><SaveStatus status={status} error={error} /></div>
    <div className="form-grid form-grid--three">
      <label>训练类型<input aria-label="训练类型" value={type} onChange={(event) => setType(event.target.value)} placeholder="力量、跑步、瑜伽" /></label>
      <label>时长（分钟）<input type="number" min="1" value={duration} onChange={(event) => setDuration(event.target.value)} placeholder="45" /></label>
    </div>
    <div className="exercise-list">
      <div className="subheading"><span>训练动作</span><button className="button button--quiet" type="button" onClick={() => setExercises((items) => [...items, { name: '', weight: '', weightUnit: 'kg', sets: '', repetitions: '', notes: '' }])}>+ 添加动作</button></div>
      {exercises.map((item, index) => <div className="form-grid form-grid--four compact-fields" key={index}>
        <label>动作 {index + 1}<input value={item.name} onChange={(event) => setExercises((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, name: event.target.value } : current))} placeholder="深蹲" /></label>
        <label>重量<input type="number" min="0" step="0.1" value={item.weight} onChange={(event) => setExercises((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, weight: event.target.value } : current))} placeholder="例如 50" /></label>
        <label>组数<input type="number" min="1" value={item.sets} onChange={(event) => setExercises((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, sets: event.target.value } : current))} /></label>
        <label>次数<input type="number" min="1" value={item.repetitions} onChange={(event) => setExercises((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, repetitions: event.target.value } : current))} /></label>
      </div>)}
    </div>
    <button className="button button--dark" type="button" disabled={disabled || status === 'saving'} onClick={save}>保存训练</button>
  </section>;
}
