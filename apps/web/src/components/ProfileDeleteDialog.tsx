import { useState } from 'react';

type DeleteProfile = { id: number; name: string; status: 'active' | 'archived'; record_days?: number; report_count?: number };

export function ProfileDeleteDialog({ profiles, onCancel, onConfirm }: { profiles: DeleteProfile[]; onCancel: () => void; onConfirm: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <section className="confirmation-dialog confirmation-dialog--danger" role="dialog" aria-modal="true" aria-label="确认永久删除档案">
    <h2>永久删除 {profiles.length} 个档案</h2>
    <p>此操作不会自动备份，并且操作不可恢复。档案、每日记录、饮食图片和报告都会永久删除。</p>
    <ul className="profile-delete-summary">{profiles.map((profile) => <li key={profile.id}><strong>{profile.name}</strong><span>{profile.status === 'active' ? '启用' : '已归档'} · 记录 {profile.record_days ?? 0} 天 · 报告 {profile.report_count ?? 0} 份</span></li>)}</ul>
    <label className="confirmation-check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我理解这些档案及其记录、图片和报告将被永久删除</label>
    <div className="dialog-actions"><button className="button button--danger-solid" type="button" disabled={!confirmed} onClick={onConfirm}>永久删除</button><button className="button button--quiet" type="button" onClick={onCancel}>取消</button></div>
  </section>;
}
