import {
  loadSettings, saveSettings, loadGlossaryText, saveGlossaryText, parseGlossary, loadSessions, saveSessions,
} from './store.js';
import { testApiKey, checkCredits, checkTextModel } from './openai.js';
import { PreciseEngine } from './engines/precise.js';
import { FastEngine } from './engines/fast.js';
import { FreeEngine, speechRecognitionSupported } from './engines/free.js';
import { DIRECTION_LABELS, targetOf } from './lang.js';
import { exportTxt, exportCsv, deliverFile } from './export.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const els = {
  feed: $('#feed'),
  empty: $('#empty'),
  emptyKeyHint: $('#emptyKeyHint'),
  status: $('#status'),
  statusLabel: $('#status .label'),
  dirChip: $('#dirChip'),
  startBtn: $('#startBtn'),
  startLabel: $('#startBtn .start-label'),
  ttsBtn: $('#ttsBtn'),
  fullBtn: $('#fullBtn'),
  jumpBtn: $('#jumpBtn'),
  toast: $('#toast'),
  panel: $('#panel'),
  viewer: $('#viewer'),
};

const STATUS_LABELS = {
  idle: '대기',
  connecting: '연결 중',
  listening: '듣는 중',
  reconnecting: '재연결 중',
  error: '오류',
};

const settings = loadSettings();
let glossary = parseGlossary(loadGlossaryText());
let sessions = loadSessions();

let running = false;
let engine = null;
let stream = null;
let audioCtx = null;
let wakeLock = null;
let record = null;          // 현재 기록 중인 세션
let stickToBottom = true;
const segNodes = new Map(); // seg.id -> DOM

// ======================================================================
// 시작 / 정지
// ======================================================================

const ENGINES = { free: FreeEngine, precise: PreciseEngine, fast: FastEngine };

function engineClass() {
  return ENGINES[settings.engine] || FreeEngine;
}

// API 키가 필요한 설정인지 (무료 모드 + Google 번역이면 필요 없음)
function needsApiKey() {
  return settings.engine !== 'free' || settings.freeTranslator === 'gpt';
}

async function start() {
  if (running) return;
  if (needsApiKey() && !settings.apiKey) {
    openPanel('settings');
    showToast(settings.engine === 'free'
      ? 'GPT 번역을 쓰려면 API 키가 필요합니다. 키가 없으면 번역기를 "Google 번역"으로 바꿔주세요.'
      : '유료 모드는 OpenAI API 키가 필요합니다. 키 없이 쓰려면 번역 엔진을 "무료"로 바꿔주세요.', 'info');
    return;
  }
  if (settings.engine === 'free' && !speechRecognitionSupported()) {
    showToast('이 브라우저는 무료 음성인식을 지원하지 않습니다. 아이폰은 Safari, PC는 Chrome 또는 Edge를 사용해주세요.');
    return;
  }

  els.startBtn.disabled = true;
  // 아이폰은 소리를 낸 직후 음성인식을 켜면 멈추는 버그가 있어서, 읽어주기를 켰을 때만 준비한다
  if (settings.tts) unlockSpeech();

  // 무료 모드는 음성인식이 마이크를 직접 열므로 여기서 마이크를 열지 않는다
  if (engineClass().needsMicStream === false) {
    if (!record) newRecord();
    running = true;
    updateRunningUi();
    requestWakeLock();
    await startEngine();
    els.startBtn.disabled = false;
    return;
  }

  // iOS는 사용자 탭 안에서 오디오를 열어야 하므로 await 전에 만든다
  const Ctx = window.AudioContext || window.webkitAudioContext;
  audioCtx = new Ctx();
  audioCtx.resume();

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: settings.micId ? { exact: settings.micId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (err) {
    els.startBtn.disabled = false;
    audioCtx.close();
    audioCtx = null;
    if (err.name === 'OverconstrainedError' && settings.micId) {
      settings.micId = '';
      saveSettings(settings);
      showToast('선택한 마이크를 찾을 수 없어 기본 마이크로 바꿨습니다. 다시 시작해주세요.');
    } else {
      showToast('마이크를 사용할 수 없습니다. 브라우저의 마이크 권한을 허용해주세요. (' + (err.message || err.name) + ')');
    }
    return;
  }

  refreshMicList();
  if (!record) newRecord();
  running = true;
  updateRunningUi();
  requestWakeLock();
  await startEngine();
  els.startBtn.disabled = false;
}

async function startEngine() {
  const Engine = engineClass();
  engine = new Engine({
    settings,
    glossary,
    stream,
    audioCtx,
    onSegment: handleSegment,
    onRemove: removeSegment,
    onStatus: (state) => {
      setStatus(state);
      if (state === 'error') stop();
    },
    onError: (err) => showToast(err.message || String(err)),
    onNotice: (text) => showToast(text, 'info', 4000),
    onLevel: (level) => els.status.style.setProperty('--level', level.toFixed(2)),
  });
  try {
    await engine.start();
  } catch (err) {
    showToast(err.message || String(err));
  }
}

function stop() {
  if (!running) return;
  running = false;
  engine?.stop();
  engine = null;
  // 정밀 모드는 마지막 문장 결과를 1.5초 정도 더 기다리므로 마이크는 조금 뒤에 끈다
  const oldStream = stream;
  const oldCtx = audioCtx;
  stream = null;
  audioCtx = null;
  setTimeout(() => {
    oldStream?.getTracks().forEach((t) => t.stop());
    oldCtx?.close();
  }, 1600);
  window.speechSynthesis?.cancel();
  releaseWakeLock();
  if (record) {
    record.endedAt = Date.now();
    persistRecord();
  }
  els.status.style.setProperty('--level', 0);
  setStatus('idle');
  updateRunningUi();
}

async function restartEngine() {
  if (!running) return;
  const old = engine;
  engine = null;
  if (old?.kind === 'free') {
    // 내장 음성인식은 한 번에 하나만 켤 수 있어서, 이전 것을 바로 끄고 잠깐 기다린다
    old.stop({ immediate: true });
    await new Promise((r) => setTimeout(r, 300));
  } else {
    old?.stop();
  }
  if (running) await startEngine();
}

function updateRunningUi() {
  els.startBtn.classList.toggle('running', running);
  els.startLabel.textContent = running ? '정지' : '시작';
  if (!running) els.jumpBtn.hidden = true;
}

function setStatus(state) {
  els.status.dataset.state = state;
  els.statusLabel.textContent = STATUS_LABELS[state] || state;
  els.status.title = STATUS_LABELS[state] || state;
}

// ======================================================================
// 자막 표시
// ======================================================================

function handleSegment(seg) {
  renderSegment(seg);
  if (seg.final) {
    saveSegment(seg);
    speak(seg);
  }
}

function renderSegment(seg) {
  let el = segNodes.get(seg.id);
  if (!el) {
    el = document.createElement('article');
    el.className = 'seg';
    el.dataset.ts = seg.ts;
    el.innerHTML = '<div class="meta"></div><div class="tr"></div><div class="src"></div>';
    insertInOrder(el, seg.ts);
    segNodes.set(seg.id, el);
    els.empty.hidden = true;
    markRecent();
  }

  const failed = seg.error && !seg.tr;
  el.classList.toggle('live', !seg.srcFinal);
  el.classList.toggle('streaming', seg.srcFinal && !seg.final);
  el.classList.toggle('error', !!failed);
  el.querySelector('.meta').textContent = `${dirTag(seg.dir)} · ${timeOf(seg.ts)}`;
  el.querySelector('.tr').textContent = failed ? '번역에 실패했습니다 (원문 참고)' : seg.tr;
  el.querySelector('.src').textContent = seg.src;
  scrollIfStuck();
}

function insertInOrder(el, ts) {
  // 인식 결과가 순서가 뒤바뀌어 도착할 수 있어서 시간순으로 끼워 넣는다
  let before = null;
  for (let node = els.feed.lastElementChild; node && node.classList.contains('seg'); node = node.previousElementSibling) {
    if (Number(node.dataset.ts) <= ts) break;
    before = node;
  }
  els.feed.insertBefore(el, before);
}

function markRecent() {
  const segs = els.feed.querySelectorAll('.seg');
  segs.forEach((node, i) => node.classList.toggle('recent', i >= segs.length - 2));
}

function removeSegment(id) {
  const el = segNodes.get(id);
  if (!el) return;
  el.remove();
  segNodes.delete(id);
  markRecent();
  if (record) record.items = record.items.filter((it) => it.id !== id);
}

function clearFeed() {
  for (const el of segNodes.values()) el.remove();
  segNodes.clear();
  els.empty.hidden = false;
}

function dirTag(dir) {
  return dir === 'ko2en' ? 'KO → EN' : dir === 'en2ko' ? 'EN → KO' : '···';
}

function timeOf(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function isNearBottom() {
  const f = els.feed;
  return f.scrollTop + f.clientHeight >= f.scrollHeight - 80;
}

function scrollIfStuck() {
  if (stickToBottom) {
    requestAnimationFrame(() => { els.feed.scrollTop = els.feed.scrollHeight; });
  } else if (running) {
    els.jumpBtn.hidden = false;
  }
}

els.feed.addEventListener('scroll', () => {
  stickToBottom = isNearBottom();
  if (stickToBottom) els.jumpBtn.hidden = true;
}, { passive: true });

els.jumpBtn.addEventListener('click', () => {
  stickToBottom = true;
  els.jumpBtn.hidden = true;
  els.feed.scrollTop = els.feed.scrollHeight;
});

// ======================================================================
// 글자 크기 · 테마 · 원문 표시
// ======================================================================

function autoFontSize() {
  return Math.round(Math.min(56, Math.max(22, window.innerWidth / 26)));
}

function applyFontSize() {
  const size = settings.fontSize || autoFontSize();
  document.documentElement.style.setProperty('--fs', `${size}px`);
}

function changeFont(factor) {
  const current = settings.fontSize || autoFontSize();
  settings.fontSize = Math.round(Math.min(120, Math.max(16, current * factor)));
  saveSettings(settings);
  applyFontSize();
  showToast(`글자 크기 ${settings.fontSize}px`, 'info', 1200);
}

function applyTheme() {
  document.documentElement.dataset.theme = settings.theme;
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && !matchMedia('(prefers-color-scheme: light)').matches);
  document.querySelector('meta[name="theme-color"]').content = dark ? '#0d1117' : '#ffffff';
}

function applyShowSource() {
  els.feed.classList.toggle('hide-source', !settings.showSource);
}

$('#fontUp').addEventListener('click', () => changeFont(1.12));
$('#fontDown').addEventListener('click', () => changeFont(1 / 1.12));
window.addEventListener('resize', () => { if (!settings.fontSize) applyFontSize(); });

// ======================================================================
// 언어 방향
// ======================================================================

function applyDirection() {
  els.dirChip.textContent = DIRECTION_LABELS[settings.direction];
  $$('input[name="direction"]').forEach((r) => { r.checked = r.value === settings.direction; });
}

els.dirChip.addEventListener('click', () => {
  // 무료 모드는 자동 감지가 없어서 영→한 / 한→영만 오간다
  const order = settings.engine === 'free' ? ['en2ko', 'ko2en'] : ['auto', 'en2ko', 'ko2en'];
  setDirection(order[(order.indexOf(settings.direction) + 1) % order.length]);
});

// 엔진에 맞게 화면을 바꾼다 (무료 모드에서 안 쓰는 설정 숨김, 자동 감지 해제)
function applyEngine() {
  if (settings.engine === 'free' && settings.direction === 'auto') {
    settings.direction = 'en2ko';
    saveSettings(settings);
  }
  $$('[data-show]').forEach((el) => { el.hidden = !el.dataset.show.split(' ').includes(settings.engine); });
  applyDirection();
  updateKeyHint();
}

function setDirection(dir) {
  if (settings.direction === dir) return;
  settings.direction = dir;
  saveSettings(settings);
  applyDirection();
  showToast(`언어 방향: ${DIRECTION_LABELS[dir]}`, 'info', 1500);
  restartEngine();
}

// ======================================================================
// 음성 읽어주기
// ======================================================================

function applyTts() {
  els.ttsBtn.setAttribute('aria-pressed', String(settings.tts));
  engine?.setTts?.(settings.tts);
}

els.ttsBtn.addEventListener('click', () => {
  settings.tts = !settings.tts;
  saveSettings(settings);
  unlockSpeech();
  applyTts();
  if (!settings.tts) window.speechSynthesis?.cancel();
  showToast(settings.tts
    ? '번역 음성 읽기 켜짐 — 이어폰을 사용하세요. 스피커로 나오면 마이크가 그 소리를 다시 인식할 수 있습니다.'
    : '번역 음성 읽기 꺼짐', 'info', settings.tts ? 4500 : 1500);
});

let speechUnlocked = false;
function unlockSpeech() {
  // iOS Safari는 사용자 탭 안에서 한 번 말해야 이후 음성 출력이 허용된다
  if (speechUnlocked || !('speechSynthesis' in window)) return;
  const u = new SpeechSynthesisUtterance(' ');
  u.volume = 0;
  window.speechSynthesis.speak(u);
  speechUnlocked = true;
}

function pickVoice(lang) {
  const voices = window.speechSynthesis.getVoices();
  const base = lang.slice(0, 2);
  return voices.find((v) => v.lang === lang && /premium|enhanced|natural|neural/i.test(v.name))
    || voices.find((v) => v.lang === lang)
    || voices.find((v) => v.lang.startsWith(base));
}

function speak(seg) {
  // 초고속 모드는 AI 통역 음성을 직접 재생하므로 여기서는 무료·정밀 모드만 처리
  if (!settings.tts || settings.engine === 'fast' || !running || !seg.tr || seg.error) return;
  if (!('speechSynthesis' in window)) return;
  const lang = targetOf(seg.dir) === 'ko' ? 'ko-KR' : 'en-US';
  const u = new SpeechSynthesisUtterance(seg.tr);
  u.lang = lang;
  const voice = pickVoice(lang);
  if (voice) u.voice = voice;
  u.rate = 1.08;
  window.speechSynthesis.speak(u);
}

// ======================================================================
// 화면 켜짐 유지 · 전체 화면
// ======================================================================

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request('screen');
  } catch { /* 지원하지 않는 브라우저 */ }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && running) requestWakeLock();
});

if (!document.fullscreenEnabled) els.fullBtn.hidden = true;
els.fullBtn.addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
  if (!document.fullscreenEnabled) return;
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

// ======================================================================
// 기록
// ======================================================================

function newRecord() {
  const now = Date.now();
  const d = new Date(now);
  const title = `${d.getMonth() + 1}월 ${d.getDate()}일 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    + (settings.topic ? ` · ${settings.topic.trim().split(/\n/)[0].slice(0, 24)}` : '');
  record = { id: `s${now}`, title, startedAt: now, endedAt: null, engine: settings.engine, items: [] };
}

function saveSegment(seg) {
  if (!record) return;
  const item = { id: seg.id, ts: seg.ts, dir: seg.dir, src: seg.src, tr: seg.tr };
  const idx = record.items.findIndex((it) => it.id === seg.id);
  if (idx >= 0) record.items[idx] = item;
  else {
    record.items.push(item);
    record.items.sort((a, b) => a.ts - b.ts);
  }
  if (!sessions.includes(record)) sessions.push(record);
  persistRecordSoon();
}

let persistTimer;
function persistRecordSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistRecord, 1000);
}

function persistRecord() {
  clearTimeout(persistTimer);
  if (record && !record.items.length) return;
  const result = saveSessions(sessions);
  if (result === 'trimmed') {
    sessions = loadSessions();
    showToast('저장 공간이 부족해 가장 오래된 기록을 삭제했습니다.', 'info');
  } else if (!result) {
    showToast('기록을 저장하지 못했습니다. 기록 탭에서 오래된 기록을 지워주세요.');
  }
}

function renderHistory() {
  const list = $('#historyList');
  list.innerHTML = '';
  const items = [...sessions].sort((a, b) => b.startedAt - a.startedAt);
  $('#historyEmpty').hidden = items.length > 0;

  for (const s of items) {
    const li = document.createElement('li');
    const end = s.endedAt || (s.items.at(-1)?.ts ?? s.startedAt);
    const mins = Math.max(1, Math.round((end - s.startedAt) / 60000));
    li.innerHTML = `
      <div class="h-title"></div>
      <div class="h-meta"></div>
      <div class="h-actions">
        <button type="button" class="btn small" data-act="view">보기</button>
        <button type="button" class="btn small" data-act="txt">TXT 저장</button>
        <button type="button" class="btn small" data-act="csv">엑셀(CSV)</button>
        <button type="button" class="btn small danger" data-act="delete">삭제</button>
      </div>`;
    li.querySelector('.h-title').textContent = s.title + (s === record && running ? ' (기록 중)' : '');
    li.querySelector('.h-meta').textContent = `${new Date(s.startedAt).toLocaleDateString('ko-KR')} · 약 ${mins}분 · ${s.items.length}문장 · ${s.engine === 'fast' ? '초고속' : '정밀'}`;
    li.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act) historyAction(act, s);
    });
    list.appendChild(li);
  }
}

async function historyAction(act, s) {
  try {
    if (act === 'view') openViewer(s);
    else if (act === 'txt') await deliverFile(exportTxt(s), `${fileBase(s)}.txt`, 'text/plain;charset=utf-8');
    else if (act === 'csv') await deliverFile(exportCsv(s), `${fileBase(s)}.csv`, 'text/csv;charset=utf-8');
    else if (act === 'delete') {
      if (!confirm(`"${s.title}" 기록을 삭제할까요? 되돌릴 수 없습니다.`)) return;
      sessions = sessions.filter((x) => x !== s);
      if (s === record) record = null;
      saveSessions(sessions);
      renderHistory();
    }
  } catch (err) {
    if (err.name !== 'AbortError') showToast('내보내기 실패: ' + err.message);
  }
}

function fileBase(s) {
  const d = new Date(s.startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `HYJK_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function openViewer(s) {
  $('#viewerTitle').textContent = s.title;
  const body = $('#viewerBody');
  body.innerHTML = '';
  for (const it of s.items) {
    const div = document.createElement('div');
    div.className = 'v-item';
    div.innerHTML = '<div class="v-time"></div><div class="v-tr"></div><div class="v-src"></div>';
    div.querySelector('.v-time').textContent = `${timeOf(it.ts)} · ${dirTag(it.dir)}`;
    div.querySelector('.v-tr').textContent = it.tr;
    div.querySelector('.v-src').textContent = it.src;
    body.appendChild(div);
  }
  els.panel.close();
  els.viewer.showModal();
}

$('#newSessionBtn').addEventListener('click', () => {
  if (record) {
    record.endedAt = Date.now();
    persistRecord();
  }
  record = null;
  clearFeed();
  if (running) newRecord();
  els.panel.close();
  showToast('화면을 비우고 새 기록을 시작합니다.', 'info', 1800);
});

// ======================================================================
// 설정 패널
// ======================================================================

function openPanel(tab = 'settings') {
  fillSettingsForm();
  selectTab(tab);
  if (!els.panel.open) els.panel.showModal();
}

function selectTab(tab) {
  $$('.tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== tab; });
  if (tab === 'history') renderHistory();
}

$$('.tabs [data-tab]').forEach((b) => b.addEventListener('click', () => selectTab(b.dataset.tab)));
$('#menuBtn').addEventListener('click', () => openPanel('settings'));
$$('[data-open]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.open)));
$$('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
$$('dialog').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close(); }));
els.panel.addEventListener('close', () => updateKeyHint());

function fillSettingsForm() {
  $('#apiKey').value = settings.apiKey;
  $('#topic').value = settings.topic;
  $('#showSource').checked = settings.showSource;
  $('#filterOther').checked = settings.filterOther;
  $('#sttModel').value = settings.sttModel;
  $('#mtModel').value = settings.mtModel;
  $('#silenceMs').value = settings.silenceMs;
  $('#silenceOut').textContent = `${(settings.silenceMs / 1000).toFixed(1)}초`;
  for (const name of ['engine', 'direction', 'freeTranslator', 'noise', 'theme']) {
    $$(`input[name="${name}"]`).forEach((r) => { r.checked = r.value === settings[name]; });
  }
  applyEngine();
  const glossaryText = loadGlossaryText();
  $('#glossary').value = glossaryText;
  updateGlossaryCount(glossaryText);
  refreshMicList();
}

function update(key, value, { restart = false } = {}) {
  if (settings[key] === value) return;
  settings[key] = value;
  saveSettings(settings);
  if (restart) restartEngine();
}

$('#apiKey').addEventListener('change', (e) => update('apiKey', e.target.value.trim()));
$('#topic').addEventListener('change', (e) => update('topic', e.target.value));
$('#mtModel').addEventListener('change', (e) => update('mtModel', e.target.value.trim() || 'gpt-6-luna'));
$('#sttModel').addEventListener('change', (e) => update('sttModel', e.target.value, { restart: settings.engine === 'precise' }));
$('#showSource').addEventListener('change', (e) => { update('showSource', e.target.checked); applyShowSource(); });
$('#filterOther').addEventListener('change', (e) => update('filterOther', e.target.checked, { restart: true }));
$('#silenceMs').addEventListener('input', (e) => { $('#silenceOut').textContent = `${(e.target.value / 1000).toFixed(1)}초`; });
$('#silenceMs').addEventListener('change', (e) => update('silenceMs', Number(e.target.value), { restart: settings.engine === 'precise' }));

for (const name of ['engine', 'direction', 'freeTranslator', 'noise', 'theme']) {
  $$(`input[name="${name}"]`).forEach((r) => r.addEventListener('change', () => {
    if (!r.checked) return;
    if (name === 'direction') return setDirection(r.value);
    if (name === 'engine') return setEngine(r.value);
    update(name, r.value, { restart: name !== 'theme' });
    if (name === 'theme') applyTheme();
  }));
}

function setEngine(value) {
  if (settings.engine === value) return;
  settings.engine = value;
  saveSettings(settings);
  applyEngine();
  // 엔진마다 마이크를 여는 방식이 달라서 실행 중이면 멈추고 다시 시작하게 한다
  if (running) {
    stop();
    showToast('번역 엔진을 바꿨습니다. 시작 버튼을 다시 눌러주세요.', 'info', 3000);
  }
}

$('#micSelect').addEventListener('change', async (e) => {
  update('micId', e.target.value);
  if (running) {
    stop();
    setTimeout(start, 1700);
  }
});

async function refreshMicList() {
  const select = $('#micSelect');
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
    select.innerHTML = '<option value="">기본 마이크</option>';
    devices.forEach((d, i) => {
      if (!d.deviceId || d.deviceId === 'default') return;
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `마이크 ${i + 1}`;
      select.appendChild(opt);
    });
    select.value = settings.micId;
    if (select.value !== settings.micId) select.value = '';
  } catch { /* 장치 목록을 볼 수 없는 환경 */ }
}

$('#testKeyBtn').addEventListener('click', async () => {
  const key = $('#apiKey').value.trim();
  update('apiKey', key);
  const out = $('#keyResult');
  out.hidden = false;
  out.className = 'help result';
  if (!key) {
    out.textContent = 'API 키를 입력해주세요.';
    out.classList.add('bad');
    return;
  }
  out.textContent = '확인 중...';
  try {
    const models = await testApiKey(key);
    if (settings.engine === 'free') {
      // 무료 모드에서는 GPT 번역만 쓰므로 번역 모델이 실제로 응답하는지만 확인한다
      await checkTextModel(key, settings.mtModel);
      out.textContent = '✓ GPT 번역을 사용할 수 있습니다.';
      out.classList.add('ok');
      updateKeyHint();
      return;
    }
    await checkCredits(key); // 키가 맞아도 잔액이 없으면 통역이 안 되므로 함께 확인
    const need = ['gpt-4o-transcribe', 'gpt-realtime-translate', settings.mtModel];
    const missing = need.filter((m) => !models.includes(m));
    if (missing.length) {
      out.textContent = `연결은 성공했지만 이 계정에서 다음 모델이 보이지 않습니다: ${missing.join(', ')}. 결제 등록 여부를 확인해주세요.`;
      out.classList.add('bad');
    } else {
      out.textContent = '✓ 연결 성공 — 정밀/초고속 모드 모두 사용할 수 있습니다.';
      out.classList.add('ok');
    }
  } catch (err) {
    out.textContent = err.message;
    out.classList.add('bad');
  }
  updateKeyHint();
});

// 용어 사전
function updateGlossaryCount(text) {
  $('#glossaryCount').textContent = `${parseGlossary(text).length}개 용어`;
}
$('#glossary').addEventListener('input', (e) => updateGlossaryCount(e.target.value));
$('#saveGlossary').addEventListener('click', () => {
  const text = $('#glossary').value;
  saveGlossaryText(text);
  glossary = parseGlossary(text);
  if (engine && engine.kind !== 'fast') engine.glossary = glossary; // 번역에는 바로 반영
  showToast(`용어 ${glossary.length}개를 저장했습니다.`, 'info', 1800);
});

function updateKeyHint() {
  els.emptyKeyHint.hidden = !needsApiKey() || !!settings.apiKey;
}

// ======================================================================
// 알림
// ======================================================================

let toastTimer;
let lastToast = { text: '', at: 0 };
function showToast(text, kind = 'error', ms = 6000) {
  const now = Date.now();
  if (text === lastToast.text && now - lastToast.at < 3000) return;
  lastToast = { text, at: now };
  els.toast.textContent = text;
  els.toast.className = `toast ${kind}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, ms);
}
els.toast.addEventListener('click', () => { els.toast.hidden = true; });

// ======================================================================
// 단축키 · 초기화
// ======================================================================

els.startBtn.addEventListener('click', () => (running ? stop() : start()));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select') || document.querySelector('dialog[open]')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === 'Space') { e.preventDefault(); running ? stop() : start(); }
  else if (e.key === '+' || e.key === '=') changeFont(1.12);
  else if (e.key === '-') changeFont(1 / 1.12);
  else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

window.addEventListener('pagehide', () => persistRecord());

applyTheme();
applyFontSize();
applyShowSource();
applyEngine();
applyTts();
setStatus('idle');

// 주소 끝에 ?demo 를 붙이면 예시 자막을 보여준다 (프로젝터에서 글자 크기 맞춰볼 때)
if (new URLSearchParams(location.search).has('demo')) {
  const now = Date.now();
  const samples = [
    ['en2ko', 'Good morning, everyone. It is great to be here in Seoul with all of you.', '여러분, 좋은 아침입니다. 이렇게 서울에서 여러분과 함께하게 되어 정말 기쁩니다.'],
    ['en2ko', 'Today I want to talk about three habits that top performers share.', '오늘은 최고의 성과를 내는 사람들이 공통적으로 가진 세 가지 습관에 대해 말씀드리겠습니다.'],
    ['ko2en', '고객님, 지금 사용하시는 제품에서 가장 불편하신 점이 무엇인가요?', 'What do you find most inconvenient about the product you are using now?'],
  ];
  samples.forEach(([dir, src, tr], i) => {
    handleSegment({ id: `demo${i}`, ts: now - (samples.length - i) * 9000, dir, src, tr, srcFinal: true, final: true });
  });
  renderSegment({ id: 'demo-live', ts: now, dir: 'en2ko', src: 'The first habit is that they listen before they', tr: '', srcFinal: false, final: false });
}

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
