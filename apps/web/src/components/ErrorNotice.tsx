type ErrorNoticeProps = {
  message: string;
  code?: string;
  requestId?: string;
  onRetry?: () => void;
};

export function ErrorNotice({ message, code, requestId, onRetry }: ErrorNoticeProps) {
  return <div className="read-error" role="alert">
    <span>{message}{code && ` [${code}]`}{requestId && ` 请求编号：${requestId}`}</span>
    {onRetry && <button className="button button--quiet" type="button" onClick={() => onRetry()}>重试</button>}
  </div>;
}
