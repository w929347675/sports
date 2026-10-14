import { useState } from 'react';
import type { Recommendation } from '../api/client.js';

export function ReportDeleteDialog({ reports, onCancel, onConfirm }: { reports: Recommendation[]; onCancel: () => void; onConfirm: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  return <section className="confirmation-dialog confirmation-dialog--danger" role="dialog" aria-modal="true" aria-label="确认删除报告">
    <h2>删除 {reports.length} 份报告</h2>
    <p>此操作不可恢复。报告只会从当前档案中删除，不会影响其他档案。</p>
    <ul className="profile-delete-summary">{reports.map((report) => <li key={report.id}><strong>{report.range_start} 至 {report.range_end}</strong><span>{report.model_name} · {report.status}</span></li>)}</ul>
    <label className="confirmation-check"><input type="checkbox" aria-label="我理解删除报告不可恢复" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />我理解删除报告不可恢复</label>
    <div className="dialog-actions"><button className="button button--danger-solid" type="button" disabled={!confirmed} onClick={onConfirm}>确认删除</button><button className="button button--quiet" type="button" onClick={onCancel}>取消</button></div>
  </section>;
}
