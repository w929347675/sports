export type RequestLogInput = {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  requestId: string;
  errorCode?: string;
};

export type RequestLogEntry = Omit<RequestLogInput, 'path' | 'durationMs'> & {
  path: string;
  durationMs: number;
};

export function createRequestLogEntry(input: RequestLogInput): RequestLogEntry {
  const entry: RequestLogEntry = {
    method: input.method,
    path: input.path.split('?', 1)[0] ?? '/',
    status: input.status,
    durationMs: Math.max(0, Math.round(input.durationMs)),
    requestId: input.requestId,
  };
  if (input.errorCode) entry.errorCode = input.errorCode;
  return entry;
}
