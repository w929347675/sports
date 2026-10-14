import { useState } from 'react';
import type { ProfileRecord, ProfileSummary } from '@fitness-coach/shared';
import { api } from '../api/client.js';
import { CurrentProfileBadge } from './CurrentProfileBadge.js';

export function ProfileSwitcher({ current, profiles, onSwitched }: { current: ProfileRecord | null; profiles: ProfileSummary[]; onSwitched: (profile: ProfileRecord) => void }) {
  const [error, setError] = useState('');
  async function switchProfile(profileId: number) {
    setError('');
    try {
      const result = await api.switchCurrentProfile(profileId);
      if (result.profile) {
        onSwitched(result.profile);
        window.dispatchEvent(new Event('profile-switched'));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法切换档案');
    }
  }
  return <div className="profile-switcher"><CurrentProfileBadge profile={current} /><label>切换档案<select aria-label="切换档案" value={current?.id ?? ''} onChange={(event) => void switchProfile(Number(event.target.value))}><option value="" disabled>选择启用档案</option>{profiles.filter(({ status }) => status === 'active').map((profile) => <option value={profile.id} key={profile.id}>{profile.name}</option>)}</select></label>{error && <span role="alert">{error}</span>}</div>;
}
