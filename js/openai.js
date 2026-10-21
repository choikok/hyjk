// OpenAI API 호출 모음 (브라우저에서 직접 호출 — api.openai.com은 CORS를 허용한다)

const API = 'https://api.openai.com/v1';

export const QUOTA_MESSAGE = 'OpenAI 잔액(크레딧)이 없습니다. platform.openai.com → Settings → Billing에서 충전한 뒤 다시 시작해주세요.';

export class ApiError extends Error {
  constructor(message, status, body, { fatal = false } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    // fatal: 다시 연결해도 해결되지 않는 오류(키 오류, 잔액 없음, 잘못된 설정) → 재시도하지 않고 멈춘다
    this.fatal = fatal;
  }
}

export function isQuotaError(error) {
  const e = error?.error || error || {};
  return /insufficient_quota|credit_balance/i.test(`${e.code || ''} ${e.type || ''}`)
    || /no credits remaining|exceeded your current quota/i.test(e.message || '');
}

async function apiError(res) {
  let body = null;
  let message = `HTTP ${res.status}`;
  try {
    body = await res.json();
    if (body?.error?.message) message = body.error.message;
  } catch { /* 본문 없음 */ }

  if (body?.error && isQuotaError(body.error)) return new ApiError(QUOTA_MESSAGE, res.status, body, { fatal: true });
  if (res.status === 401) return new ApiError('API 키가 올바르지 않습니다. 설정에서 키를 확인해주세요.', 401, body, { fatal: true });
  if (res.status === 403) return new ApiError(`이 API 키로는 사용할 수 없는 기능입니다: ${message}`, 403, body, { fatal: true });
  if (res.status === 400) return new ApiError(`설정 오류: ${message}`, 400, body, { fatal: true });
  if (res.status === 429) message = `요청이 너무 많습니다. 잠시 후 다시 연결합니다. (${message})`;
  if (res.status >= 500) message = `OpenAI 서버 오류 (HTTP ${res.status})`;
  return new ApiError(message, res.status, body);
}

// 잔액이 있는지 아주 작은 요청으로 확인한다 (실시간 연결은 잔액이 없을 때 원인 없이 500만 돌려주는 경우가 있다)
export async function checkCredits(apiKey, model = 'gpt-6-luna') {
  const res = await safeFetch(`${API}/responses`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: 'ok', max_output_tokens: 16, store: false }),
  });
  if (!res.ok) throw await apiError(res);
}

// 네트워크 오류(인터넷 끊김, 또는 오류 응답에 CORS 헤더가 없는 경우)를 알아보기 쉬운 메시지로 바꾼다
async function safeFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('OpenAI 서버에 연결하지 못했습니다. 인터넷 연결과 API 키를 확인해주세요.', 0);
  }
}

export async function testApiKey(apiKey) {
  const res = await safeFetch(`${API}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  return (data.data || []).map((m) => m.id);
}

// 실시간 세션용 짧은 수명의 토큰(client secret) 발급
export async function createClientSecret(apiKey, path, body) {
  const res = await safeFetch(`${API}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await apiError(res);
  const data = await res.json();
  const value = data.value || data.client_secret?.value;
  if (!value) throw new ApiError('세션 토큰을 받지 못했습니다.', res.status, data);
  return value;
}

// WebRTC로 실시간 세션에 연결. 마이크 트랙을 보내고 'oai-events' 데이터 채널로 이벤트를 받는다.
export async function connectRealtime({ secret, callsPath, track, onEvent, onRemoteStream, onStateChange }) {
  const pc = new RTCPeerConnection();
  pc.ontrack = (e) => onRemoteStream?.(e.streams[0]);
  pc.addTrack(track);

  const dc = pc.createDataChannel('oai-events');
  dc.addEventListener('message', (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch (err) {
      console.warn('이벤트 해석 실패', err, e.data);
    }
  });

  const opened = new Promise((resolve, reject) => {
    dc.addEventListener('open', resolve, { once: true });
    setTimeout(() => reject(new Error('실시간 연결 시간 초과')), 15000);
  });
  opened.catch(() => { /* 아래에서 await할 때 처리한다 */ });

  pc.addEventListener('connectionstatechange', () => onStateChange?.(pc.connectionState));
  dc.addEventListener('close', () => onStateChange?.('channel-closed'));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  try {
    const res = await safeFetch(`${API}${callsPath}`, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/sdp',
      },
    });
    if (!res.ok) throw await apiError(res);
    await pc.setRemoteDescription({ type: 'answer', sdp: await res.text() });
    await opened;
  } catch (err) {
    onStateChange = null; // 실패해서 닫는 것이므로 '연결 끊김'으로 알리지 않는다
    pc.close();
    throw err;
  }

  return {
    pc,
    dc,
    send(event) {
      if (dc.readyState === 'open') dc.send(JSON.stringify(event));
    },
    close() {
      try { dc.close(); } catch { /* 이미 닫힘 */ }
      try { pc.close(); } catch { /* 이미 닫힘 */ }
    },
  };
}

// Responses API 스트리밍. 번역 텍스트 조각(delta)을 onDelta로 넘기고 최종 텍스트를 반환한다.
export async function streamText({ apiKey, model, instructions, input, onDelta, signal }) {
  const body = {
    model,
    instructions,
    input,
    stream: true,
    store: false,
    reasoning: { effort: 'none' },
  };

  let res = await postResponses(apiKey, body, signal);
  if (res.status === 400) {
    // reasoning 옵션을 지원하지 않는 모델이면 옵션 없이 다시 시도
    const err = await apiError(res);
    if (!/reasoning/i.test(err.message)) throw err;
    delete body.reasoning;
    res = await postResponses(apiKey, body, signal);
  }
  if (!res.ok) throw await apiError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const dataLine = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('');
      if (!dataLine || dataLine === '[DONE]') continue;
      let event;
      try { event = JSON.parse(dataLine); } catch { continue; }

      if (event.type === 'response.output_text.delta') {
        text += event.delta;
        onDelta?.(text);
      } else if (event.type === 'response.output_text.done' && typeof event.text === 'string') {
        text = event.text;
      } else if (event.type === 'error' || event.type === 'response.failed') {
        const msg = event.error?.message || event.response?.error?.message || '번역 실패';
        throw new ApiError(msg, 0, event);
      }
    }
  }
  return text.trim();
}

async function postResponses(apiKey, body, signal) {
  return safeFetch(`${API}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
}
