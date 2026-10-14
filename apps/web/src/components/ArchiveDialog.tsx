export function ArchiveDialog({ profileName, action, onCancel, onConfirm }: {
  profileName: string;
  action: 'archive' | 'restore';
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const archive = action === 'archive';
  return <section className="confirmation-dialog" role="dialog" aria-modal="true" aria-label={archive ? '确认归档' : '确认恢复'}>
    <h2>{archive ? '归档档案' : '恢复档案'}</h2>
    <p>{archive ? `归档“${profileName}”后，档案、记录、图片和报告仍会保留，但全部变为只读。` : `恢复“${profileName}”为启用档案？恢复后不会自动切换当前档案。`}</p>
    <div className="dialog-actions"><button className="button button--dark" type="button" onClick={onConfirm}>{archive ? '确认归档' : '确认恢复'}</button><button className="button button--quiet" type="button" onClick={onCancel}>取消</button></div>
  </section>;
}
