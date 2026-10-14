import type { RecommendationJob } from '@fitness-coach/shared';

export function RecommendationError({ job, onRetry, retryDisabled = false }: { job: RecommendationJob; onRetry: () => void; retryDisabled?: boolean }) {
  return <section className="read-error" role="alert">
    <span>
      <strong>报告生成失败</strong>
      <br />{job.error_message ?? '请检查模型配置后重试。'}
      <br />阶段：{job.error_phase ?? '未知'}
      <br />错误码：{job.error_code ?? 'UNKNOWN_ERROR'}
      {job.request_id && <><br />请求编号：{job.request_id}</>}
    </span>
    <button className="button button--quiet" type="button" disabled={retryDisabled} onClick={onRetry}>重试生成</button>
  </section>;
}
