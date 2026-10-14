import type { ProfileRecord } from '@fitness-coach/shared';

export function CurrentProfileBadge({ profile }: { profile: ProfileRecord | null }) {
  if (!profile) return <div className="profile-badge profile-badge--empty">未选择档案</div>;
  return <div className="profile-badge" aria-label="当前档案"><span>当前档案</span><strong>{profile.name}</strong>{profile.status === 'archived' && <em>只读归档</em>}</div>;
}
