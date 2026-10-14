import type { ManagedProfile } from '../api/client.js';

const goalLabels = { fat_loss: '减脂', muscle_gain: '增肌', maintain: '维持', custom: '自定义' };
const date = (value: string | null | undefined) => value ? value.slice(0, 10) : '暂无';

export function ProfileList({ profiles, currentProfileId, selected, onSelected, onSelectAll, onOpen, onArchive, onRestore }: {
  profiles: ManagedProfile[];
  currentProfileId?: number;
  selected: Set<number>;
  onSelected: (id: number, checked: boolean) => void;
  onSelectAll: (checked: boolean) => void;
  onOpen: (id: number) => void;
  onArchive: (profile: ManagedProfile) => void;
  onRestore: (profile: ManagedProfile) => void;
}) {
  if (profiles.length === 0) return <section className="panel empty-panel"><span className="empty-icon">NO PROFILES</span><h2>没有符合条件的档案</h2><p>调整筛选条件，或创建一个新的启用档案。</p></section>;
  return <section className="profile-list" aria-label="档案列表">
    <label className="profile-select-all"><input type="checkbox" aria-label="全选档案" checked={profiles.every(({ id }) => selected.has(id))} onChange={(event) => onSelectAll(event.target.checked)} />选择当前结果中的全部档案</label>
    {profiles.map((profile) => <article className="profile-card" key={profile.id}>
      <label className="profile-card__check"><input type="checkbox" aria-label={`选择 ${profile.name}`} checked={selected.has(profile.id)} onChange={(event) => onSelected(profile.id, event.target.checked)} /></label>
      <button className="profile-card__main" type="button" onClick={() => onOpen(profile.id)}>
        <span className="profile-card__title"><strong>{profile.name}</strong><span className={`status-pill status-pill--${profile.status}`}>{profile.status === 'active' ? '启用' : '已归档'}</span>{currentProfileId === profile.id && <span className="current-marker">当前档案</span>}</span>
        <span className="profile-card__goal">{goalLabels[profile.goal]}{profile.goal_description ? ` · ${profile.goal_description}` : ''}</span>
        <span className="profile-card__metrics"><span>记录 {profile.record_days} 天</span><span>报告 {profile.report_count} 份</span><span>最近记录 {date(profile.last_entry_at)}</span><span>最近报告 {date(profile.last_recommendation_at)}</span></span>
        <span className="profile-card__flags">{profile.has_unconfirmed_diet && <span>有待确认饮食</span>}{profile.has_high_risk_feedback && <span className="risk-flag">有高风险反馈</span>}<span>更新 {date(profile.updated_at)}</span></span>
      </button>
      <div className="profile-card__actions">{profile.status === 'archived' ? <button className="button button--outline" type="button" aria-label={`恢复 ${profile.name}`} onClick={() => onRestore(profile)}>恢复</button> : currentProfileId === profile.id ? <span className="helper">切换后可归档</span> : <button className="button button--outline" type="button" aria-label={`归档 ${profile.name}`} onClick={() => onArchive(profile)}>归档</button>}</div>
    </article>)}
  </section>;
}
