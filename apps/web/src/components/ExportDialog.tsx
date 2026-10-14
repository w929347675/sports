import type { ManagedProfile } from '../api/client.js';

export function ExportDialog({
  profiles,
  selected,
  onSelected,
  onExport,
}: {
  profiles: ManagedProfile[];
  selected: Set<number>;
  onSelected: (id: number, checked: boolean) => void;
  onExport: () => void;
}) {
  return <section className="panel transfer-export">
    <div className="section-heading"><div><span className="eyebrow">导出</span><h2>选择档案导出</h2></div><span className="tag">不包含 API Key</span></div>
    <div className="transfer-profile-list">
      {profiles.map((profile) => <label className="transfer-profile-option" key={profile.id}>
        <input aria-label={`选择 ${profile.name}`} type="checkbox" checked={selected.has(profile.id)} onChange={(event) => onSelected(profile.id, event.target.checked)} />
        <span><strong>{profile.name}</strong><small>{profile.status === 'active' ? '启用' : '已归档'}</small></span>
      </label>)}
    </div>
    <button className="button button--dark" type="button" disabled={selected.size === 0} onClick={onExport}>导出所选档案</button>
  </section>;
}
