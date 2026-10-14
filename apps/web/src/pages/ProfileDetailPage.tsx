import { useEffect, useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { api, type ManagedProfileDetail } from '../api/client.js';
import { ArchiveDialog } from '../components/ArchiveDialog.js';
import { ProfileForm } from '../components/ProfileForm.js';

const goalLabels = { fat_loss: '减脂', muscle_gain: '增肌', maintain: '维持', custom: '自定义' };

export function ProfileDetailPage({ profileId, currentProfile, onProfilesChanged, navigate }: {
  profileId: number;
  currentProfile: ProfileRecord | null;
  onProfilesChanged: (profile: ProfileRecord | null) => void;
  navigate: (path: string) => void;
}) {
  const [profile, setProfile] = useState<ManagedProfileDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let current = true;
    setProfile(null);
    setError('');
    void api.getProfileById(profileId)
      .then((next) => { if (current) setProfile(next); })
      .catch((cause) => { if (current) setError(cause instanceof Error ? cause.message : '档案读取失败'); });
    return () => { current = false; };
  }, [profileId]);

  if (error) return <main className="page-shell"><div className="read-error" role="alert">{error}</div><button className="button button--quiet" onClick={() => navigate('/profiles')}>返回档案列表</button></main>;
  if (!profile) return <main className="page-shell"><span className="spinner" />正在读取档案...</main>;
  const archived = profile.status === 'archived';

  async function save(input: Parameters<typeof api.updateProfile>[1]) {
    const saved = await api.updateProfile(profileId, input);
    setEditing(false);
    const next = await api.getProfileById(profileId);
    setProfile(next);
    if (currentProfile?.id === saved.id) onProfilesChanged(saved);
  }

  async function switchToProfile() {
    const result = await api.switchCurrentProfile(profileId);
    onProfilesChanged(result.profile);
    window.dispatchEvent(new Event('profile-switched'));
  }

  async function restoreProfile() {
    await api.restoreProfile(profileId);
    const next = await api.getProfileById(profileId);
    setProfile(next);
    setConfirmRestore(false);
  }

  return <main className="page-shell profile-detail-page">
    <button className="button button--quiet" type="button" onClick={() => navigate('/profiles')}>← 返回档案列表</button>
    <div className="page-title-row"><div><div className="page-kicker">档案详情 / {archived ? '只读归档' : '启用'}</div><h1>{profile.name}</h1><p>{goalLabels[profile.goal]}{profile.goal_description ? ` · ${profile.goal_description}` : ''}</p></div><div className="page-actions">{archived && <button className="button button--dark" type="button" onClick={() => setConfirmRestore(true)}>恢复档案</button>}{!archived && currentProfile?.id !== profile.id && <button className="button button--dark" type="button" onClick={() => void switchToProfile()}>切换到此档案</button>}{!archived && <button className="button button--outline" type="button" onClick={() => setEditing((value) => !value)}>{editing ? '取消编辑' : '编辑资料'}</button>}</div></div>
    {confirmRestore && <ArchiveDialog profileName={profile.name} action="restore" onCancel={() => setConfirmRestore(false)} onConfirm={() => void restoreProfile()} />}
    {archived && <div className="archive-readonly" role="status"><strong>只读归档</strong><span>可以查看档案资料、记录、趋势和历史报告，但不能修改、删除记录、上传图片、识别饮食或生成报告。</span></div>}
    {editing && !archived ? <ProfileForm profile={profile} submitLabel="保存修改" onSubmit={save} onCancel={() => setEditing(false)} /> : <>
      <section className="metric-grid profile-metrics"><div className="metric"><span>记录天数</span><strong>{profile.summary.record_days}</strong></div><div className="metric"><span>报告数量</span><strong>{profile.summary.report_count}</strong></div><div className="metric"><span>最近记录</span><strong>{profile.summary.last_entry_at ?? '暂无'}</strong></div><div className="metric"><span>最近报告</span><strong>{profile.summary.last_recommendation_at?.slice(0, 10) ?? '暂无'}</strong></div></section>
      <section className="panel profile-overview"><h2>基础资料</h2><dl><div><dt>身高</dt><dd>{profile.height_cm} cm</dd></div><div><dt>年龄</dt><dd>{profile.age}</dd></div><div><dt>训练经验</dt><dd>{profile.training_experience}</dd></div><div><dt>器械与场地</dt><dd>{profile.equipment}</dd></div><div><dt>每周训练</dt><dd>{profile.training_days_per_week} 天</dd></div><div><dt>单次时长</dt><dd>{profile.session_duration_minutes} 分钟</dd></div><div><dt>饮食偏好</dt><dd>{profile.diet_preferences || '无'}</dd></div><div><dt>过敏限制</dt><dd>{profile.allergies || '无'}</dd></div><div><dt>健康限制</dt><dd>{profile.health_restrictions || '无'}</dd></div></dl></section>
      <section className="profile-detail-links"><section className="panel"><strong>每日记录</strong><span>{profile.daily_entries.length === 0 ? '暂无记录' : `共 ${profile.daily_entries.length} 天`}</span>{profile.daily_entries.slice(0, 5).map((entry) => <div className="profile-detail-row" key={entry.id}><b>{entry.entry_date}</b><span>{entry.status}{entry.meals.length > 0 ? ` · 餐次 ${entry.meals.length}` : ''}{entry.workouts.length > 0 ? ` · 训练 ${entry.workouts.length}` : ''}{entry.feedback.length > 0 ? ` · 反馈 ${entry.feedback.length}` : ''}</span></div>)}</section><section className="panel"><strong>长期查看</strong><span>该档案的数据与当前档案隔离。</span><div className="profile-detail-row"><b>最近记录</b><span>{profile.summary.last_entry_at ?? '暂无'}</span></div><div className="profile-detail-row"><b>记录天数</b><span>{profile.summary.record_days} 天</span></div><div className="profile-detail-row"><b>饮食确认</b><span>{profile.summary.has_unconfirmed_diet ? '有待确认项目' : '暂无待确认项目'}</span></div><div className="profile-detail-row"><b>身体反馈</b><span>{profile.summary.has_high_risk_feedback ? '存在高风险反馈' : '暂无高风险反馈'}</span></div></section><section className="panel"><strong>历史报告</strong><span>{profile.recommendations.length === 0 ? '暂无历史报告' : `共 ${profile.recommendations.length} 份`}</span>{profile.recommendations.slice(0, 5).map((report) => <div className="profile-detail-row" key={report.id}><b>{report.range_start} 至 {report.range_end}</b><span>{report.model_name} · {report.status}</span></div>)}</section></section>
    </>}
  </main>;
}
