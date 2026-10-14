import { useEffect, useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { api, type ManagedProfile, type ProfileListFilters } from '../api/client.js';
import { ArchiveDialog } from '../components/ArchiveDialog.js';
import { ProfileDeleteDialog } from '../components/ProfileDeleteDialog.js';
import { ProfileFilters } from '../components/ProfileFilters.js';
import { ProfileForm } from '../components/ProfileForm.js';
import { ProfileList } from '../components/ProfileList.js';

const defaultFilters: Required<ProfileListFilters> = {
  status: 'active', timeField: 'updated_at', from: '', to: '', sort: 'updated_at', order: 'desc',
};

export function ProfilesPage({ currentProfile, onProfilesChanged, navigate }: {
  currentProfile: ProfileRecord | null;
  onProfilesChanged: (profile: ProfileRecord | null) => void;
  navigate: (path: string) => void;
}) {
  const [profiles, setProfiles] = useState<ManagedProfile[]>([]);
  const [filters, setFilters] = useState(defaultFilters);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState<{ profile: ManagedProfile; action: 'archive' | 'restore' } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function load(nextFilters = filters) {
    setError('');
    try {
      const result = await api.listProfiles(nextFilters);
      setProfiles(result);
      setSelected((current) => new Set([...current].filter((id) => result.some((profile) => profile.id === id))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '档案列表读取失败');
    }
  }

  useEffect(() => { void load(filters); }, [filters.status, filters.timeField, filters.from, filters.to, filters.sort, filters.order]);

  function changeFilters(next: Required<ProfileListFilters>) { setFilters(next); }

  async function create(input: Parameters<typeof api.createProfile>[0]) {
    const created = await api.createProfile(input);
    setCreating(false);
    onProfilesChanged(created);
    window.dispatchEvent(new Event('profile-switched'));
    await load();
  }

  async function archiveOrRestore() {
    if (!confirming) return;
    setError('');
    try {
      if (confirming.action === 'archive') await api.archiveProfile(confirming.profile.id);
      else await api.restoreProfile(confirming.profile.id);
      setConfirming(null);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '档案状态更新失败');
    }
  }

  const selectedProfiles = profiles.filter(({ id }) => selected.has(id));
  async function removeSelected() {
    setError('');
    try {
      const result = await api.deleteProfiles(selectedProfiles.map(({ id }) => id));
      setDeleting(false);
      setSelected(new Set());
      if (result.cleanup_failures.length > 0) setError(`档案已删除，但以下图片清理失败：${result.cleanup_failures.join('、')}`);
      onProfilesChanged(currentProfile);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '档案删除失败');
    }
  }

  return <main className="page-shell profiles-page">
    <div className="page-kicker">档案管理 / 本地隔离</div>
    <div className="page-title-row"><div><h1>管理每一个训练档案</h1><p>档案是记录、图片和报告的隔离边界。当前档案：<strong>{currentProfile?.name ?? '暂无启用档案'}</strong></p></div><div className="page-actions"><button className="button button--dark" type="button" onClick={() => setCreating(true)}>新增档案</button><button className="button button--danger" type="button" disabled={selectedProfiles.length === 0 || selectedProfiles.some(({ id }) => id === currentProfile?.id)} onClick={() => setDeleting(true)}>永久删除所选</button></div></div>
    {!currentProfile && <div className="archive-readonly" role="status"><strong>当前没有可记录的启用档案</strong><span>可以查看或恢复归档档案，也可以新建启用档案；每日记录、识别和报告生成入口已隐藏。</span></div>}
    <ProfileFilters filters={filters} onChange={changeFilters} />
    {error && <div className="read-error" role="alert"><span>{error}</span><button className="button button--quiet" type="button" onClick={() => void load()}>重试读取</button></div>}
    {creating && <section className="profile-editor"><div className="section-heading"><div><span className="eyebrow">新档案</span><h2>填写身体与训练资料</h2></div></div><ProfileForm submitLabel="创建并切换" onSubmit={create} onCancel={() => setCreating(false)} /></section>}
    {confirming && <ArchiveDialog profileName={confirming.profile.name} action={confirming.action} onCancel={() => setConfirming(null)} onConfirm={() => void archiveOrRestore()} />}
    {deleting && <ProfileDeleteDialog profiles={selectedProfiles} onCancel={() => setDeleting(false)} onConfirm={() => void removeSelected()} />}
    <ProfileList profiles={profiles} currentProfileId={currentProfile?.id} selected={selected} onSelected={(id, checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} onSelectAll={(checked) => setSelected(checked ? new Set(profiles.map(({ id }) => id)) : new Set())} onOpen={(id) => navigate(`/profiles/${id}`)} onArchive={(profile) => setConfirming({ profile, action: 'archive' })} onRestore={(profile) => setConfirming({ profile, action: 'restore' })} />
  </main>;
}
