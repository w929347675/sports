import { createServer } from 'node:http';

const port = Number(process.env.MOCK_AI_PORT ?? 4321);
const requests: Array<{ kind: 'recognition' | 'recommendation'; imageCount: number; hasAuthorization: boolean; structuredData: boolean; highRisk: boolean }> = [];

const recognition = {
  items: [{ name: '鸡胸肉', amount: 150, unit: 'g', confidence: 0.72, needsConfirmation: true, notes: '份量为估计值' }],
  cookingMethod: '煎',
  uncertainties: ['份量为估计值'],
};

const recommendation = {
  summary: '本阶段记录已保存并完成一次主动分析。',
  trend: { observations: ['体重趋势需要继续观察。'] },
  trainingPlan: Array.from({ length: 7 }, (_, index) => ({ day: index + 1, focus: index === 0 ? '主动恢复' : '力量训练', exercises: ['深蹲', '推举'] })),
  dietAdvice: ['优先确认食物份量，避免把估计值当作精确数据。'],
  recovery: ['保持规律睡眠。'],
  followUps: ['七天后复查记录覆盖率。'],
  safety: { level: 'low', banner: '如不适持续或加重，请停止相关动作并寻求专业评估。' },
  uncertainties: ['部分份量来自模型估计。'],
};

function json(response: import('node:http').ServerResponse, status: number, data: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(data));
}

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/test/reset') {
    requests.length = 0;
    json(response, 200, { ok: true });
    return;
  }
  if (request.method === 'GET' && request.url === '/test/state') {
    json(response, 200, { requests });
    return;
  }
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    json(response, 404, { error: 'not found' });
    return;
  }

  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    let body: { messages?: Array<{ role?: string; content?: unknown }> } = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body; } catch { json(response, 400, { error: 'invalid json' }); return; }
    const user = body.messages?.find((message) => message.role === 'user');
    const content = user?.content;
    const imageCount = Array.isArray(content) ? content.filter((item) => typeof item === 'object' && item !== null && 'image_url' in item).length : 0;
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    const kind = imageCount > 0 ? 'recognition' : 'recommendation';
    const highRisk = text.includes('highRisk') || text.includes('pain') || text.includes('疼痛');
    requests.push({ kind, imageCount, hasAuthorization: Boolean(request.headers.authorization), structuredData: text.includes('structuredData'), highRisk });
    const output = kind === 'recognition' ? recognition : {
      ...recommendation,
      safety: highRisk ? { level: 'high', banner: '记录中存在高风险不适，请停止相关动作并寻求专业评估。' } : recommendation.safety,
    };
    json(response, 200, { choices: [{ message: { content: JSON.stringify(output) } }] });
  });
});

server.listen(port, '127.0.0.1');
