type SaveStatusProps = {
  status: 'idle' | 'saving' | 'saved' | 'error';
  error?: string;
};

export function SaveStatus({ status, error }: SaveStatusProps) {
  if (status === 'saving') return <span className="save-status" role="status">保存中...</span>;
  if (status === 'saved') return <span className="save-status save-status--success" role="status">已保存到本机</span>;
  if (status === 'error') return <span className="save-status save-status--error" role="alert">{error ?? '保存失败'}</span>;
  return null;
}
