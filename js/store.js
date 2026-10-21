// 설정 · 용어 사전 · 기록을 이 기기의 localStorage에 저장한다.
// (API 키도 이 기기에만 저장되며 OpenAI 외의 곳으로는 전송되지 않는다.)

const KEYS = {
  settings: 'hyjk.settings.v1',
  glossary: 'hyjk.glossary.v1',
  sessions: 'hyjk.sessions.v1',
};

const SETTINGS_VERSION = 2;

export const DEFAULT_SETTINGS = {
  version: SETTINGS_VERSION,
  apiKey: '',
  engine: 'free',               // 'free' (내장 음성인식+무료 번역) | 'precise' (OpenAI 인식+GPT, 유료) | 'fast' (gpt-realtime-translate, 유료)
  freeTranslator: 'google',     // 무료 모드의 번역기: 'google' (키 불필요) | 'gpt' (API 키 필요)
  direction: 'en2ko',           // 'auto' (유료 모드만) | 'en2ko' | 'ko2en'
  topic: '',                    // 강연 주제/배경 (정밀 모드 번역에 사용)
  micId: '',
  noise: 'far_field',           // 'far_field' (강연장) | 'near_field' (핀마이크)
  sttModel: 'gpt-live-transcribe',
  mtModel: 'gpt-6-luna',
  silenceMs: 700,               // 문장 끝으로 판단할 침묵 길이
  showSource: true,
  theme: 'dark',                // 'dark' | 'light' | 'system'
  fontSize: 0,                  // 0 = 화면 크기에 맞춰 자동
  tts: false,
};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('저장 실패', key, err);
    return false;
  }
}

export function loadSettings() {
  const saved = read(KEYS.settings, {});
  const settings = { ...DEFAULT_SETTINGS, ...saved };
  if ((saved.version || 1) < 2) {
    // v2: 무료 모드가 기본이 됐다
    settings.engine = 'free';
    if (settings.direction === 'auto') settings.direction = 'en2ko';
    settings.version = SETTINGS_VERSION;
    write(KEYS.settings, settings);
  }
  return settings;
}

export function saveSettings(settings) {
  write(KEYS.settings, settings);
}

// ---------- 용어 사전 ----------
// 한 줄에 하나씩 "English term = 한국어 용어" 형식. '#'으로 시작하는 줄은 메모.

export function loadGlossaryText() {
  return read(KEYS.glossary, '');
}

export function saveGlossaryText(text) {
  write(KEYS.glossary, text);
}

export function parseGlossary(text) {
  const pairs = [];
  for (const line of (text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^(.+?)\s*(?:=|→|->|:|\t)\s*(.+)$/);
    if (m) pairs.push({ en: m[1].trim(), ko: m[2].trim() });
    else pairs.push({ en: trimmed, ko: trimmed }); // 번역하지 않고 그대로 둘 고유명사
  }
  return pairs;
}

// ---------- 기록 ----------

export function loadSessions() {
  return read(KEYS.sessions, []);
}

export function saveSessions(sessions) {
  if (write(KEYS.sessions, sessions)) return true;
  // 용량 초과 시 오래된 기록부터 지우고 다시 시도
  const trimmed = [...sessions];
  while (trimmed.length > 1) {
    trimmed.shift();
    if (write(KEYS.sessions, trimmed)) return 'trimmed';
  }
  return false;
}
