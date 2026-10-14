import type { ProfileRecord, ProfileSummary } from '@fitness-coach/shared';
import { ProfileSwitcher } from './ProfileSwitcher.js';

export function Nav({ path, navigate, currentProfile, profiles, onProfileSwitched }: { path: string; navigate: (path: string) => void; currentProfile: ProfileRecord | null; profiles: ProfileSummary[]; onProfileSwitched: (profile: ProfileRecord) => void }) {
  const links = currentProfile
    ? [['/', '今日记录'], ['/history', '历史趋势'], ['/recommendations', '后续建议'], ['/reports', '报告'], ['/profile', '档案'], ['/profiles', '管理'], ['/profile-transfer', '导入导出'], ['/settings', '设置']]
    : [['/profiles', '管理'], ['/profile-transfer', '导入导出'], ['/settings', '设置']];
  return <aside className="sidebar">
    <div className="brand"><span className="brand-mark">FC</span><div><strong>Fitness Coach</strong><span>本地训练日志</span></div></div>
    <nav aria-label="主导航">{links.map(([href, label]) => <a href={href} className={path.split('?')[0] === href || (href === '/profiles' && path.startsWith('/profiles/')) || (href === '/reports' && path.startsWith('/reports/')) ? 'nav-link nav-link--active' : 'nav-link'} key={href} onClick={(event) => { event.preventDefault(); navigate(href); }}>{label}</a>)}</nav>
    <ProfileSwitcher current={currentProfile} profiles={profiles} onSwitched={onProfileSwitched} /><div className="sidebar-note"><span className="status-dot" />数据保存在本机</div>
  </aside>;
}
