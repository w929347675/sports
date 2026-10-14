import type { ProfileTransferPreview, ProfileTransferResolution } from '../api/client.js';
import { ConflictResolver } from './ConflictResolver.js';

export function ImportPreview({
  preview,
  resolutions,
  onResolution,
  onCancelImport,
}: {
  preview: ProfileTransferPreview;
  resolutions: Record<number, ProfileTransferResolution>;
  onResolution: (resolution: ProfileTransferResolution) => void;
  onCancelImport: () => void;
}) {
  return <section className="panel transfer-preview">
    <div className="section-heading"><div><span className="eyebrow">导入</span><h2>导入预览</h2></div><span className="tag">格式 v{preview.manifest.version}</span></div>
    <div className="transfer-summary"><strong>{preview.profileStats.length} 个档案</strong><span>每日记录：{preview.manifest.counts.daily_entries ?? 0}</span><span>图片：{preview.manifest.counts.meal_images ?? 0}</span><span>报告：{preview.manifest.counts.recommendations ?? 0}</span></div>
    <div className="transfer-profile-list">
      {preview.profileStats.map((profile, index) => <div className="transfer-profile-option" key={profile.id}><span><strong>{profile.name}</strong><small>状态：{profile.status === 'active' ? (index === 0 ? '启用' : '启用档案') : '已归档'}</small><small>每日记录：{profile.records.daily_entries ?? 0}</small><small>图片：{profile.images}</small><small>报告：{profile.reports}</small></span></div>)}
    </div>
    {preview.conflicts.length > 0 && <><h3>冲突处理</h3><ConflictResolver preview={preview} resolutions={resolutions} onChange={onResolution} onCancelImport={onCancelImport} /></>}
  </section>;
}
