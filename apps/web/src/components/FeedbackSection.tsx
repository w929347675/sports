import { useState } from 'react';
import { api, entryTimestamp } from '../api/client.js';
import { SaveStatus } from './SaveStatus.js';

export function FeedbackSection({ date, disabled = false, onSaved }: { date: string; disabled?: boolean; onSaved: () => void }) {
  const [category, setCategory] = useState('normal');
  const [bodyPart, setBodyPart] = useState('');
  const [severity, setSeverity] = useState('0');
  const [description, setDescription] = useState('');
  const [impact, setImpact] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');

  async function save() {
    setStatus('saving');
    try {
      await api.createFeedback(date, { recorded_at: entryTimestamp(date), category: category as 'normal', body_part: bodyPart || '全身', severity: Number(severity), impact, description: description || '无特别描述' });
      setBodyPart('');
      setDescription('');
      setImpact('');
      setStatus('saved');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存身体反馈失败');
      setStatus('error');
    }
  }

  return <section className="record-section">
    <div className="section-heading"><div><span className="eyebrow">04 / 身体反馈</span><h2>记录今天的感受</h2></div><SaveStatus status={status} error={error} /></div>
    <div className="form-grid form-grid--four">
      <label>反馈类型<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="normal">正常体感</option><option value="discomfort">不适</option><option value="pain">疼痛</option><option value="fatigue">疲劳</option><option value="other">其他</option></select></label>
      <label>部位<input value={bodyPart} onChange={(event) => setBodyPart(event.target.value)} placeholder="膝盖、腰背..." /></label>
      <label>程度（0-10）<input type="number" min="0" max="10" step="1" value={severity} onChange={(event) => setSeverity(event.target.value)} /></label>
      <label>影响<input value={impact} onChange={(event) => setImpact(event.target.value)} placeholder="走路、睡眠、训练..." /></label>
    </div>
    <label>描述<input value={description} onChange={(event) => setDescription(event.target.value)} placeholder="今天的身体感受" /></label>
    <button className="button button--dark" type="button" disabled={disabled || status === 'saving'} onClick={save}>保存身体反馈</button>
  </section>;
}
