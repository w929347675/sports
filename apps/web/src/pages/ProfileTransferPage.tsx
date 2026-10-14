import { useEffect, useMemo, useState } from 'react';
import type { ProfileRecord } from '@fitness-coach/shared';
import { api, type ManagedProfile, type ProfileTransferPreview, type ProfileTransferResolution, type ProfileTransferResult } from '../api/client.js';
import { ExportDialog } from '../components/ExportDialog.js';
import { ImportPreview } from '../components/ImportPreview.js';

export function ProfileTransferPage({ currentProfile, onProfilesChanged, navigate }: { currentProfile: ManagedProfile | ProfileRecord | null; onProfilesChanged: (profile: ProfileRecord | null) => void; navigate?: (path: string) => void }) {
  const [profiles, setProfiles] = useState<ManagedProfile[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [preview, setPreview] = useState<ProfileTransferPreview | null>(null);
  const [resolutions, setResolutions] = useState<Record<number, ProfileTransferResolution>>({});
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [resultSummary, setResultSummary] = useState<{ imported: number; skipped: number } | null>(null);
  const [cleanupFailures, setCleanupFailures] = useState<string[]>([]);
  const [importResult, setImportResult] = useState<ProfileTransferResult | null>(null);
  const [error, setError] = useState('');

  async function loadProfiles() {
    try { setProfiles(await api.listProfiles({ status: 'all' })); } catch (cause) { setError(cause instanceof Error ? cause.message : '档案读取失败'); }
  }
  useEffect(() => { void loadProfiles(); }, []);

  async function exportSelected() {
    setBusy(true); setError('');
    try { await api.exportProfiles([...selected]); setMessage('导出已下载到本机'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导出失败'); }
    finally { setBusy(false); }
  }
  async function previewFile(file: File | undefined) {
    if (!file) return;
    setBusy(true); setError(''); setMessage('');
    try { const next = await api.previewProfileImport(file); setPreview(next); setResolutions({}); setResultSummary(null); setCleanupFailures([]); setImportResult(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '导入预检失败'); }
    finally { setBusy(false); }
  }
  function onResolution(next: ProfileTransferResolution) { setResolutions((current) => ({ ...current, [next.profileId]: next })); }
  const canExecute = useMemo(() => Boolean(preview) && preview!.conflicts.every((conflict) => {
    const resolution = resolutions[conflict.profileId];
    return resolution && resolution.strategy !== 'cancel' && (resolution.strategy !== 'new' || Boolean(resolution.newName?.trim()));
  }), [preview, resolutions]);
  async function execute() {
    if (!preview || !canExecute) return;
    setBusy(true); setError(''); setConfirming(false);
    try {
      const result = await api.executeProfileImport(preview.importId, Object.values(resolutions));
      const imported = result.results.filter((item) => item.status === 'imported').length;
      const skipped = result.results.filter((item) => item.status === 'skipped').length;
      setMessage('导入完成');
      setResultSummary({ imported, skipped });
      setCleanupFailures(result.cleanup_failures ?? []);
      setImportResult(result);
      await loadProfiles();
      onProfilesChanged(currentProfile);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '档案导入失败'); }
    finally { setBusy(false); }
  }
  async function switchToProfile(profileId: number) {
    try {
      const switched = await api.switchCurrentProfile(profileId);
      onProfilesChanged(switched.profile);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '切换档案失败');
    }
  }
  const importedProfiles = importResult?.results.flatMap((item) => {
    if (item.status !== 'imported') return [];
    const source = preview?.profileStats.find((profile) => profile.id === item.sourceProfileId);
    return source ? [{ ...source, targetProfileId: item.targetProfileId }] : [];
  }) ?? [];
  return <main className="page-shell profile-transfer-page">
    <div className="page-kicker">档案导入导出 / 本地数据</div>
    <div className="page-title-row"><div><h1>安全转移训练档案</h1><p>导出只包含明确选中的档案；导入会先校验包内容，不会携带 API Key 或全局模型设置。</p></div><span className="tag">当前档案：{currentProfile?.name ?? '暂无'}</span></div>
    {error && <div className="read-error" role="alert">{error}</div>}
    {message && <div className="save-status save-status--success" role="status"><span>{message}</span>{resultSummary && <><span>已导入 {resultSummary.imported} 个档案</span><span>已跳过 {resultSummary.skipped} 个档案</span></>}</div>}
    {cleanupFailures.length > 0 && <div className="read-error" role="alert">导入完成，但清理失败：{cleanupFailures.join('、')}</div>}
    {importedProfiles.length > 0 && <section className="panel transfer-results"><h2>导入结果</h2>{!currentProfile && importedProfiles.every((profile) => profile.status === 'archived') && <p className="notice">导入内容仅包含归档档案。请恢复其中一个档案或创建启用档案后再记录。</p>}<div className="transfer-profile-list">{importedProfiles.map((profile) => <div className="transfer-profile-option" key={profile.targetProfileId}><span><strong>{profile.name}</strong><small>{profile.status === 'active' ? '启用' : '已归档'}</small></span><div className="dialog-actions"><button className="button button--outline" type="button" onClick={() => navigate?.(`/profiles/${profile.targetProfileId}`)}>查看档案</button>{profile.status === 'active' && <button className="button button--dark" type="button" onClick={() => void switchToProfile(profile.targetProfileId)}>切换到此档案</button>}</div></div>)}</div></section>}
    <ExportDialog profiles={profiles} selected={selected} onSelected={(id, checked) => setSelected((current) => { const next = new Set(current); if (checked) next.add(id); else next.delete(id); return next; })} onExport={() => void exportSelected()} />
    <section className="panel transfer-import"><div className="section-heading"><div><span className="eyebrow">导入</span><h2>导入档案包</h2></div></div><label>选择档案包<input aria-label="选择档案包" type="file" accept=".tar.gz,application/gzip" onChange={(event) => void previewFile(event.target.files?.[0])} /></label></section>
    {preview && <ImportPreview preview={preview} resolutions={resolutions} onResolution={onResolution} onCancelImport={() => { setPreview(null); setResolutions({}); setMessage('已取消导入'); }} />}
    {preview && <div className="form-actions"><button className="button button--dark" type="button" disabled={busy || !canExecute} onClick={() => setConfirming(true)}>执行导入</button></div>}
    {confirming && <div className="confirmation-dialog" role="dialog" aria-label="确认执行档案导入"><h2>确认执行档案导入</h2><p>导入会新增或覆盖所选档案及其关联记录和图片。此操作不可自动恢复。</p><div className="dialog-actions"><button className="button button--dark" type="button" onClick={() => void execute()}>确认导入</button><button className="button button--quiet" type="button" onClick={() => setConfirming(false)}>取消</button></div></div>}
  </main>;
}
