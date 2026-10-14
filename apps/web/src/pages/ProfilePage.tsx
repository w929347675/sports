import { useState } from 'react';
import type { Profile } from '@fitness-coach/shared';
import { api, type ProfileInput } from '../api/client.js';
import { SaveStatus } from '../components/SaveStatus.js';

const emptyProfile: ProfileInput = {
  goal: 'fat_loss', height_cm: 170, age: 30, sex: 'unspecified', training_experience: '', equipment: '',
  training_days_per_week: 3, session_duration_minutes: 45, diet_preferences: '', allergies: '', health_restrictions: '',
};

export function ProfilePage({ profile, onSaved }: { profile: Profile | null; onSaved: (profile: Profile) => void }) {
  const [form, setForm] = useState<ProfileInput>(profile ? {
    goal: profile.goal, height_cm: profile.height_cm, age: profile.age, sex: profile.sex,
    training_experience: profile.training_experience, equipment: profile.equipment,
    training_days_per_week: profile.training_days_per_week, session_duration_minutes: profile.session_duration_minutes,
    diet_preferences: profile.diet_preferences, allergies: profile.allergies, health_restrictions: profile.health_restrictions,
  } : emptyProfile);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const update = <K extends keyof ProfileInput>(key: K, value: ProfileInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaveState('saving');
    try {
      const saved = await api.saveProfile(form);
      setSaveState('saved');
      onSaved(saved);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '档案保存失败');
      setSaveState('error');
    }
  }

  return <main className="page-shell page-shell--narrow">
    <div className="page-kicker">个人档案 / 本地配置</div>
    <div className="page-title-row"><div><h1>{profile ? '更新你的健身档案' : '建立你的健身档案'}</h1><p>这些信息只用于本机记录和未来由你主动发起的分析。</p></div><SaveStatus status={saveState} error={error} /></div>
    <form className="panel form-panel" onSubmit={save}>
      <section className="form-block"><h2>目标与能力</h2><div className="form-grid form-grid--three">
        <label>目标<select value={form.goal} onChange={(event) => update('goal', event.target.value as ProfileInput['goal'])}><option value="fat_loss">减脂</option><option value="muscle_gain">增肌</option><option value="maintain">维持</option><option value="custom">自定义</option></select></label>
        <label>身高（cm）<input type="number" min="1" value={form.height_cm} onChange={(event) => update('height_cm', Number(event.target.value))} /></label>
        <label>年龄<input type="number" min="1" max="150" value={form.age} onChange={(event) => update('age', Number(event.target.value))} /></label>
        <label>性别<select value={form.sex} onChange={(event) => update('sex', event.target.value as ProfileInput['sex'])}><option value="unspecified">不透露</option><option value="female">女性</option><option value="male">男性</option><option value="other">其他</option></select></label>
        <label>训练经验<input required value={form.training_experience} onChange={(event) => update('training_experience', event.target.value)} placeholder="初学、规律训练..." /></label>
        <label>器械与场地<input required value={form.equipment} onChange={(event) => update('equipment', event.target.value)} placeholder="家用器械、健身房..." /></label>
      </div></section>
      <section className="form-block"><h2>训练安排</h2><div className="form-grid form-grid--three">
        <label>每周训练天数<input type="number" min="0" max="7" value={form.training_days_per_week} onChange={(event) => update('training_days_per_week', Number(event.target.value))} /></label>
        <label>单次训练时长（分钟）<input type="number" min="1" value={form.session_duration_minutes} onChange={(event) => update('session_duration_minutes', Number(event.target.value))} /></label>
      </div></section>
      <section className="form-block"><h2>饮食与健康边界</h2><div className="form-grid"><label>饮食偏好<textarea value={form.diet_preferences} onChange={(event) => update('diet_preferences', event.target.value)} placeholder="例如：家常饮食、素食..." /></label><label>过敏和饮食限制<textarea value={form.allergies} onChange={(event) => update('allergies', event.target.value)} placeholder="没有请填写无" /></label><label>既往伤病与需要避免的动作<textarea value={form.health_restrictions} onChange={(event) => update('health_restrictions', event.target.value)} placeholder="没有请填写无" /></label></div></section>
      <div className="form-actions"><button className="button button--dark" type="submit" disabled={saveState === 'saving'}>保存档案</button></div>
    </form>
  </main>;
}
