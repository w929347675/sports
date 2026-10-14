import { useState } from 'react';
import { api, entryTimestamp } from '../api/client.js';
import { SaveStatus } from './SaveStatus.js';

export function WeightSection({ date, disabled = false, onSaved }: { date: string; disabled?: boolean; onSaved: () => void }) {
  const [weight, setWeight] = useState('');
  const [note, setNote] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  async function save() {
    setStatus('saving');
    try {
      await api.createWeight(date, { measured_at: entryTimestamp(date), weight_kg: Number(weight), note });
      setWeight('');
      setNote('');
      setStatus('saved');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存体重失败');
      setStatus('error');
    }
  }

  return <section className="record-section">
    <div className="section-heading"><div><span className="eyebrow">01 / 身体指标</span><h2>体重</h2></div><SaveStatus status={status} error={error} /></div>
    <div className="form-grid form-grid--three">
      <label>体重（kg）<input aria-label="体重（kg）" type="number" min="0.1" step="0.1" value={weight} onChange={(event) => setWeight(event.target.value)} placeholder="72.5" /></label>
      <label>备注<input value={note} onChange={(event) => setNote(event.target.value)} placeholder="晨起、训练后..." /></label>
      <button className="button button--dark" type="button" disabled={disabled || !weight || status === 'saving'} onClick={save}>保存体重</button>
    </div>
  </section>;
}
