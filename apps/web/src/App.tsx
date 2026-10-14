import { useEffect, useState } from 'react';
import type { Profile, ProfileRecord } from '@fitness-coach/shared';
import type { ManagedProfile } from './api/client.js';
import { api } from './api/client.js';
import { Nav } from './components/Nav.js';
import { DailyEntryPage } from './pages/DailyEntryPage.js';
import { HistoryPage } from './pages/HistoryPage.js';
import { ProfilePage } from './pages/ProfilePage.js';
import { RecommendationsPage } from './pages/RecommendationsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { WorkbenchPage } from './pages/WorkbenchPage.js';
import { MealDetailPage } from './pages/MealDetailPage.js';
import { ProfilesPage } from './pages/ProfilesPage.js';
import { ProfileDetailPage } from './pages/ProfileDetailPage.js';
import { ProfileTransferPage } from './pages/ProfileTransferPage.js';
import { ReportsPage } from './pages/ReportsPage.js';
import { ReportDetailPage } from './pages/ReportDetailPage.js';
import './styles.css';

function pathFromLocation() { return `${window.location.pathname.replace(/\/$/, '') || '/'}${window.location.search}`; }

export function App() {
  const [path, setPath] = useState(pathFromLocation);
  const [profile, setProfile] = useState<Profile | null | undefined>(undefined);
  const [currentProfile, setCurrentProfile] = useState<ProfileRecord | null>(null);
  const [profiles, setProfiles] = useState<ManagedProfile[]>([]);
  const [loadError, setLoadError] = useState('');
  async function loadProfileContext() {
    const [saved, current, available] = await Promise.all([api.getProfile(), api.getCurrentProfile(), api.listProfiles({ status: 'all' })]);
    setProfile(saved);
    setCurrentProfile(current.profile);
    setProfiles(available);
  }
  useEffect(() => { void loadProfileContext().catch((cause) => setLoadError(cause instanceof Error ? cause.message : '无法读取本地档案')); }, []);
  useEffect(() => { const reload = () => { setPath(pathFromLocation()); void loadProfileContext(); }; window.addEventListener('profile-switched', reload); return () => window.removeEventListener('profile-switched', reload); }, []);
  useEffect(() => { const onPopState = () => setPath(pathFromLocation()); window.addEventListener('popstate', onPopState); return () => window.removeEventListener('popstate', onPopState); }, []);

  function navigate(nextPath: string) { window.history.pushState({}, '', nextPath); setPath(nextPath.replace(/\/$/, '') || '/'); }

  function onProfileSaved(saved: Profile) {
    setProfile(saved);
    if ('name' in saved && typeof saved.name === 'string') setCurrentProfile(saved as ProfileRecord);
    navigate('/');
  }

  function onProfilesChanged(next: ProfileRecord | null) {
    setCurrentProfile(next);
    setProfile(next);
    void api.listProfiles({ status: 'all' }).then(setProfiles);
  }

  if (loadError) return <main className="loading-screen"><strong>本地服务不可用</strong><span>{loadError}</span></main>;
  if (profile === undefined) return <main className="loading-screen"><span className="spinner" />正在读取本机数据...</main>;
  const reportPath = path.split('?')[0];
  const isReportPath = reportPath === '/reports' || /^\/reports\/\d+(\/\d+)?$/.test(reportPath);
  if (!profile && !path.startsWith('/profiles') && path !== '/profile' && path !== '/profile-transfer' && !isReportPath) {
    return profiles.length === 0
      ? <ProfilePage profile={null} onSaved={onProfileSaved} />
      : <ProfilesPage currentProfile={currentProfile} onProfilesChanged={onProfilesChanged} navigate={navigate} />;
  }

  const profileDetailMatch = path.split('?')[0].match(/^\/profiles\/(\d+)$/);
  const reportListMatch = path.split('?')[0].match(/^\/reports\/(\d+)$/);
  const reportDetailMatch = path.split('?')[0].match(/^\/reports\/(\d+)\/(\d+)$/);
  const content = path === '/profile' ? <ProfilePage profile={profile} onSaved={onProfileSaved} />
    : path === '/profiles' ? <ProfilesPage currentProfile={currentProfile} onProfilesChanged={onProfilesChanged} navigate={navigate} />
      : profileDetailMatch ? <ProfileDetailPage profileId={Number(profileDetailMatch[1])} currentProfile={currentProfile} onProfilesChanged={onProfilesChanged} navigate={navigate} />
    : path === '/profile-transfer' ? <ProfileTransferPage currentProfile={currentProfile} onProfilesChanged={onProfilesChanged} navigate={navigate} />
    : path === '/settings' ? <SettingsPage />
      : path === '/history' ? <HistoryPage navigate={navigate} />
            : path === '/recommendations' ? <RecommendationsPage currentProfile={currentProfile} navigate={navigate} />
              : path === '/reports' ? <ReportsPage currentProfile={currentProfile} navigate={navigate} />
                : reportListMatch ? <ReportsPage currentProfile={currentProfile} profileId={Number(reportListMatch[1])} navigate={navigate} />
                : reportDetailMatch ? <ReportDetailPage profileId={Number(reportDetailMatch[1])} reportId={Number(reportDetailMatch[2])} currentProfile={currentProfile} navigate={navigate} />
            : path.startsWith('/entry/') ? <DailyEntryPage date={path.slice('/entry/'.length).split('?')[0]} navigate={navigate} />
            : <WorkbenchPage navigate={navigate} />;

  const [pathname, search = ''] = path.split('?');
  const mealMatch = pathname.match(/^\/entry\/([^?]+)$/);
  const mealQuery = new URLSearchParams(search).get('meal');
  const routedContent = mealMatch
    && mealQuery && /^\d+$/.test(mealQuery)
    ? <MealDetailPage date={mealMatch[1]} mealId={Number(mealQuery)} onBack={() => navigate(`/entry/${mealMatch[1]}`)} />
    : content;

  return <div className="app-layout"><Nav path={path} navigate={navigate} currentProfile={currentProfile} profiles={profiles} onProfileSwitched={onProfilesChanged} /><div className="content-area" key={currentProfile?.id ?? 'none'}>{routedContent}</div></div>;
}
