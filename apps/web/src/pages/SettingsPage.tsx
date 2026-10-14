import { useEffect, useRef, useState } from 'react';
import { api, type ApiRequestError, type BackupMetadata } from '../api/client.js';
import { SaveStatus } from '../components/SaveStatus.js';
import { ErrorNotice } from '../components/ErrorNotice.js';

function apiError(cause: unknown): ApiRequestError | null {
  if (cause instanceof Error && typeof (cause as Partial<ApiRequestError>).code === 'string') {
    return cause as ApiRequestError;
  }
  return null;
}

export function SettingsPage() {
  const [baseUrl, setBaseUrl] = useState('');
  const [modelName, setModelName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [configured, setConfigured] = useState(false);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState<ApiRequestError | null>(null);
  const [connectionMessage, setConnectionMessage] = useState('');
  const [backups, setBackups] = useState<BackupMetadata[]>([]);
  const [includeImages, setIncludeImages] = useState(false);
  const [operationMessage, setOperationMessage] = useState('');
  const editedFields = useRef(new Set<'baseUrl' | 'modelName' | 'apiKey'>());
  useEffect(() => {
    void api.getModelSettings().then((settings) => {
      if (!editedFields.current.has('baseUrl')) setBaseUrl(settings.baseUrl ?? '');
      if (!editedFields.current.has('modelName')) setModelName(settings.modelName ?? '');
      if (!editedFields.current.has('apiKey')) setConfigured(settings.configured);
    }).catch((cause) => { setError(cause instanceof Error ? cause.message : '读取设置失败'); setErrorDetails(apiError(cause)); setStatus('error'); });
    void Promise.resolve(api.listBackups()).then((recent) => setBackups(recent ?? [])).catch(() => setBackups([]));
  }, []);

  function editField(field: 'baseUrl' | 'modelName' | 'apiKey', value: string) {
    editedFields.current.add(field);
    if (field === 'baseUrl') setBaseUrl(value);
    if (field === 'modelName') setModelName(value);
    if (field === 'apiKey') setApiKey(value);
  }

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (configured && !apiKey) {
      setError('已配置 API Key。为了不让前端读取旧 Key，请重新输入 API Key 后再保存其他设置。');
      setErrorDetails(null);
      setStatus('error');
      return;
    }
    setStatus('saving');
    setErrorDetails(null);
    try {
      const settings = await api.saveModelSettings({ base_url: baseUrl, model_name: modelName, api_key: apiKey });
      setConfigured(settings.configured);
      setApiKey('');
      setStatus('saved');
    } catch (cause) { setError(cause instanceof Error ? cause.message : '设置保存失败'); setErrorDetails(apiError(cause)); setStatus('error'); }
  }

  async function clearKey() {
    setStatus('saving');
    setError('');
    setErrorDetails(null);
    try { const settings = await api.clearModelSettings(); setConfigured(settings.configured); setApiKey(''); setStatus('saved'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : '清除失败'); setErrorDetails(apiError(cause)); setStatus('error'); }
  }

  async function testConnection() {
    setStatus('saving');
    setConnectionMessage('');
    setError('');
    setErrorDetails(null);
    try {
      const result = await api.testModelConnection();
      setConnectionMessage(`连接成功：${result.modelName}`);
      setStatus('saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败');
      setErrorDetails(apiError(cause));
      setStatus('error');
    }
  }

  async function createBackup() {
    setStatus('saving');
    setError('');
    setOperationMessage('');
    setErrorDetails(null);
    try {
      await api.createBackup();
      setBackups((await api.listBackups()) ?? []);
      setOperationMessage('备份已保存到本机');
      setStatus('saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '备份失败');
      setErrorDetails(apiError(cause));
      setStatus('error');
    }
  }

  async function exportJson() {
    setStatus('saving');
    setError('');
    setOperationMessage('');
    setErrorDetails(null);
    try {
      await api.downloadJsonExport(includeImages);
      setOperationMessage('导出已下载到本机');
      setStatus('saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败');
      setErrorDetails(apiError(cause));
      setStatus('error');
    }
  }

  return <main className="page-shell page-shell--narrow"><div className="page-kicker">设置 / 模型连接</div><div className="page-title-row"><div><h1>本地连接设置</h1><p>模型只在你主动点击识别或生成建议时被调用。</p></div><SaveStatus status={status === 'error' ? 'idle' : status} error={error} /></div>
    <form className="panel form-panel" onSubmit={save}><section className="form-block"><h2>OpenAI 兼容接口</h2><div className="form-grid"><label>Base URL<input type="url" required value={baseUrl} onChange={(event) => editField('baseUrl', event.target.value)} placeholder="https://example.test/v1" /></label><label>模型名<input required value={modelName} onChange={(event) => editField('modelName', event.target.value)} placeholder="模型名称" /></label><label>API Key<input aria-label="API Key" type="password" required={!configured} value={apiKey} onChange={(event) => editField('apiKey', event.target.value)} placeholder={configured ? '已配置，输入新 Key 可替换' : '仅在此处提交'} /></label></div><div className="secret-state"><span className={configured ? 'status-dot' : 'status-dot status-dot--muted'} />{configured ? 'API Key 已配置，前端不会读取或显示它。' : '尚未配置 API Key。'}</div></section><div className="form-actions"><button className="button button--dark" type="submit" disabled={status === 'saving'}>保存设置</button>{configured && <><button className="button button--quiet" type="button" disabled={status === 'saving'} onClick={() => void testConnection()}>测试连接</button><button className="button button--quiet" type="button" onClick={clearKey}>清除 API Key</button></>}</div>{connectionMessage && <p className="save-status save-status--success" role="status">{connectionMessage}</p>}</form>
     {operationMessage && <p className="save-status save-status--success" role="status">{operationMessage}</p>}
     {status === 'error' && error && <ErrorNotice message={error} code={errorDetails?.code} requestId={errorDetails?.requestId} />}
     <section className="panel data-tools">
       <div className="section-heading"><div><div className="eyebrow">本机数据</div><h2>备份与导出</h2></div><span className="tag">不会包含 API Key</span></div>
       <p className="helper">备份包含本机数据库、图片和 schema 版本；API Key 存在独立的本机密钥文件中，不会进入备份或 JSON 导出。</p>
       <div className="form-actions form-actions--compact"><button className="button button--dark" type="button" disabled={status === 'saving'} onClick={() => void createBackup()}>创建本地备份</button><button className="button button--outline" type="button" disabled={status === 'saving'} onClick={() => void exportJson()}>导出 JSON</button><label className="confirmation-check"><input type="checkbox" checked={includeImages} onChange={(event) => setIncludeImages(event.target.checked)} />导出时包含图片</label></div>
       <div className="backup-list"><strong>最近备份</strong>{backups.length === 0 ? <span className="muted">尚无备份</span> : backups.slice(0, 3).map((backup) => <div className="backup-row" key={backup.filename}><span>{backup.filename}</span><span className="muted">{Math.ceil(backup.size / 1024)} KB</span></div>)}</div>
     </section>
     <div className="notice"><strong>外部传输边界</strong><p>本地记录、原图、报告、备份和导出默认只保存到本机。只有你主动发起模型操作时，选中的必要数据才会发送给配置的服务商；导出和备份均不包含 API Key。</p></div>
   </main>;
}
