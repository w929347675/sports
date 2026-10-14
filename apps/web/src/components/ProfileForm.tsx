import { useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import type { ManagedProfileInput } from '../api/client.js';

const emptyProfile: ManagedProfileInput = {
  name: '', goal: 'maintain', goal_description: '', height_cm: 170, age: 30, sex: 'unspecified',
  training_experience: '', equipment: '', training_days_per_week: 3, session_duration_minutes: 45,
  diet_preferences: '', allergies: '', health_restrictions: '',
};

export function ProfileForm({ profile, submitLabel, onSubmit, onCancel }: {
  profile?: ProfileRecord;
  submitLabel: string;
  onSubmit: (input: ManagedProfileInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState<ManagedProfileInput>(profile ? {
    name: profile.name, goal: profile.goal, goal_description: profile.goal_description,
    height_cm: profile.height_cm, age: profile.age, sex: profile.sex,
    training_experience: profile.training_experience, equipment: profile.equipment,
    training_days_per_week: profile.training_days_per_week, session_duration_minutes: profile.session_duration_minutes,
    diet_preferences: profile.diet_preferences, allergies: profile.allergies, health_restrictions: profile.health_restrictions,
  } : emptyProfile);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const update = <K extends keyof ManagedProfileInput>(key: K, value: ManagedProfileInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      await onSubmit(form);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '档案保存失败');
    } finally {
      setSaving(false);
    }
  }

  return <form className="panel form-panel" onSubmit={submit}>
    <section className="form-block"><h2>档案与目标</h2><div className="form-grid form-grid--three">
      <label>档案名称<input required value={form.name} onChange={(event) => update('name', event.target.value)} /></label>
      <label>目标<select value={form.goal} onChange={(event) => update('goal', event.target.value as ManagedProfileInput['goal'])}><option value="fat_loss">减脂</option><option value="muscle_gain">增肌</option><option value="maintain">维持</option><option value="custom">自定义</option></select></label>
      <label>目标描述<input value={form.goal_description} onChange={(event) => update('goal_description', event.target.value)} /></label>
      <label>身高（cm）<input required type="number" min="1" value={form.height_cm} onChange={(event) => update('height_cm', Number(event.target.value))} /></label>
      <label>年龄<input required type="number" min="1" max="150" value={form.age} onChange={(event) => update('age', Number(event.target.value))} /></label>
      <label>性别<select value={form.sex} onChange={(event) => update('sex', event.target.value as ManagedProfileInput['sex'])}><option value="unspecified">不透露</option><option value="female">女性</option><option value="male">男性</option><option value="other">其他</option></select></label>
    </div></section>
    <section className="form-block"><h2>训练条件</h2><div className="form-grid form-grid--three">
      <label>训练经验<input required value={form.training_experience} onChange={(event) => update('training_experience', event.target.value)} /></label>
      <label>器械与场地<input required value={form.equipment} onChange={(event) => update('equipment', event.target.value)} /></label>
      <label>每周训练天数<input required type="number" min="0" max="7" value={form.training_days_per_week} onChange={(event) => update('training_days_per_week', Number(event.target.value))} /></label>
      <label>单次训练时长（分钟）<input required type="number" min="1" value={form.session_duration_minutes} onChange={(event) => update('session_duration_minutes', Number(event.target.value))} /></label>
    </div></section>
    <section className="form-block"><h2>饮食与健康边界</h2><div className="form-grid">
      <label>饮食偏好<textarea value={form.diet_preferences} onChange={(event) => update('diet_preferences', event.target.value)} /></label>
      <label>过敏和饮食限制<textarea value={form.allergies} onChange={(event) => update('allergies', event.target.value)} /></label>
      <label>既往伤病与需要避免的动作<textarea value={form.health_restrictions} onChange={(event) => update('health_restrictions', event.target.value)} /></label>
    </div></section>
    {error && <div className="read-error" role="alert">{error}</div>}
    <div className="form-actions"><button className="button button--dark" type="submit" disabled={saving}>{saving ? '保存中...' : submitLabel}</button>{onCancel && <button className="button button--quiet" type="button" onClick={onCancel}>取消</button>}</div>
  </form>;
}
