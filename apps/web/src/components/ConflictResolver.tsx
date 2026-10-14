import type { ProfileTransferConflict, ProfileTransferPreview, ProfileTransferResolution } from '../api/client.js';

export function ConflictResolver({
  preview,
  resolutions,
  onChange,
  onCancelImport,
}: {
  preview: ProfileTransferPreview;
  resolutions: Record<number, ProfileTransferResolution>;
  onChange: (resolution: ProfileTransferResolution) => void;
  onCancelImport: () => void;
}) {
  const conflictsByProfile = new Map<number, ProfileTransferConflict[]>();
  for (const conflict of preview.conflicts) conflictsByProfile.set(conflict.profileId, [...(conflictsByProfile.get(conflict.profileId) ?? []), conflict]);
  return <div className="transfer-conflicts">
    {preview.profileStats.filter((profile) => conflictsByProfile.has(profile.id)).map((profile) => {
      const resolution = resolutions[profile.id];
      return <div className="transfer-conflict" key={profile.id}>
        <div><strong>{profile.name}</strong><span className="muted">{conflictsByProfile.get(profile.id)?.map((conflict) => conflict.type === 'profile_id' ? `ID 冲突：${conflict.existingName}` : `名称冲突：${conflict.existingName}`).join('，')}</span></div>
        <label>{profile.name} 的冲突处理<select aria-label={`${profile.name} 的冲突处理`} value={resolution?.strategy ?? 'new'} onChange={(event) => {
          const strategy = event.target.value as ProfileTransferResolution['strategy'];
          if (strategy === 'cancel') onCancelImport();
          else onChange({ profileId: profile.id, strategy });
        }}>
          <option value="new">作为新档案</option><option value="overwrite">覆盖已有档案</option><option value="skip">跳过</option><option value="cancel">取消导入</option>
        </select></label>
        {resolution?.strategy === 'new' && <label>{profile.name} 的新档案名称<input value={resolution.newName ?? ''} onChange={(event) => onChange({ ...resolution, newName: event.target.value })} /></label>}
      </div>;
    })}
  </div>;
}
