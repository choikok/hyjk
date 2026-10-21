// 초고속 모드: OpenAI 동시통역 전용 모델(gpt-realtime-translate). 말하는 도중에도 번역이 계속 흘러나온다.
// 모델이 한 세션에 한 가지 출력 언어만 지원하므로, 자동 모드에서는 한국어용·영어용 세션 두 개를 동시에 연다.
// 각 세션은 이미 출력 언어로 말한 내용은 번역하지 않으므로, 원문 언어를 보고 해당하는 쪽만 화면에 보여준다.

import { createClientSecret, connectRealtime, checkCredits, isQuotaError, QUOTA_MESSAGE } from '../openai.js';
import { VoiceActivity } from '../vad.js';
import { detectLang, directionFor } from '../lang.js';

const GAP_MS = 1600;        // 이만큼 아무 출력이 없으면 다음 문단으로 넘긴다
const LONG_BLOCK = 180;     // 문단이 이보다 길어지면 문장이 끝나는 곳에서 끊는다

export class FastEngine {
  constructor({ settings, stream, audioCtx, onSegment, onRemove, onStatus, onError, onLevel }) {
    this.kind = 'fast';
    this.settings = settings;
    this.stream = stream;
    this.audioCtx = audioCtx;
    this.cb = { onSegment, onRemove, onStatus, onError, onLevel };
    this.seq = 0;
    this.running = false;
    this.tts = settings.tts;

    const targets = settings.direction === 'auto' ? ['ko', 'en'] : [settings.direction === 'en2ko' ? 'ko' : 'en'];
    this.lanes = targets.map((target) => ({ target, gen: 0, conn: null, block: null, retries: 0, audio: makeAudio() }));
  }

  async start() {
    this.running = true;
    this.vad = new VoiceActivity(this.audioCtx, this.stream, { onLevel: this.cb.onLevel });
    this.vad.start();
    await Promise.all(this.lanes.map((lane) => this.connect(lane)));
  }

  stop() {
    this.running = false;
    this.vad?.stop();
    for (const lane of this.lanes) {
      lane.gen++;
      clearTimeout(lane.retryTimer);
      clearTimeout(lane.gapTimer);
      lane.conn?.send({ type: 'session.close' });
      const conn = lane.conn;
      lane.conn = null;
      setTimeout(() => conn?.close(), 800);
      this.closeBlock(lane);
      lane.audio.srcObject = null;
      lane.audio.remove();
    }
  }

  setTts(on) {
    this.tts = on;
    for (const lane of this.lanes) this.updateMute(lane);
  }

  // ---------- 연결 ----------

  async connect(lane) {
    const gen = ++lane.gen;
    this.reportStatus('connecting');
    try {
      const secret = await createClientSecret(this.settings.apiKey, '/realtime/translations/client_secrets', {
        session: {
          model: 'gpt-realtime-translate',
          audio: {
            input: {
              transcription: { model: 'gpt-realtime-whisper' },
              noise_reduction: { type: this.settings.noise },
            },
            output: { language: lane.target },
          },
        },
      });
      if (gen !== lane.gen) return;
      const conn = await connectRealtime({
        secret,
        callsPath: '/realtime/translations/calls',
        track: this.stream.getAudioTracks()[0].clone(),
        onEvent: (ev) => gen === lane.gen && this.handleEvent(lane, ev),
        onRemoteStream: (remote) => {
          lane.audio.srcObject = remote;
          lane.audio.play().catch(() => { /* 음성 출력이 막혀도 자막은 계속 나온다 */ });
        },
        onStateChange: (state) => gen === lane.gen && this.handleState(lane, state),
      });
      if (gen !== lane.gen || !this.running) { conn.close(); return; }
      lane.conn = conn;
      lane.retries = 0;
      this.updateMute(lane);
      this.reportStatus();
    } catch (err) {
      if (gen !== lane.gen) return;
      if (err.fatal) return this.fail(err);
      if (err.status >= 500) {
        // 실시간 연결은 잔액이 없을 때 원인 없이 500을 돌려주는 경우가 있어 잔액부터 확인한다
        try {
          await checkCredits(this.settings.apiKey);
        } catch (creditErr) {
          if (creditErr.fatal) return this.fail(creditErr);
        }
      }
      if (!this.running) return;
      this.cb.onError(err);
      this.scheduleReconnect(lane);
    }
  }

  fail(err) {
    if (!this.running) return;
    this.running = false;
    this.cb.onError(err);
    this.cb.onStatus('error');
  }

  reportStatus(state) {
    if (state) return this.cb.onStatus(state);
    if (this.lanes.every((l) => l.conn)) this.cb.onStatus('listening');
  }

  handleState(lane, state) {
    if (!this.running) return;
    if (state === 'failed' || state === 'closed' || state === 'channel-closed') {
      this.scheduleReconnect(lane);
    } else if (state === 'disconnected') {
      clearTimeout(lane.discTimer);
      lane.discTimer = setTimeout(() => {
        if (lane.conn?.pc.connectionState === 'disconnected') this.scheduleReconnect(lane);
      }, 4000);
    }
  }

  scheduleReconnect(lane) {
    if (!this.running) return;
    lane.gen++;
    lane.conn?.close();
    lane.conn = null;
    this.closeBlock(lane);
    lane.retries++;
    const delay = Math.min(10000, 500 * 2 ** Math.min(lane.retries, 5));
    this.cb.onStatus('reconnecting');
    clearTimeout(lane.retryTimer);
    lane.retryTimer = setTimeout(() => this.running && this.connect(lane), delay);
  }

  // ---------- 이벤트 ----------

  handleEvent(lane, ev) {
    switch (ev.type) {
      case 'session.input_transcript.delta':
        this.append(lane, 'src', ev.delta);
        break;
      case 'session.output_transcript.delta':
        this.append(lane, 'tr', ev.delta);
        break;
      case 'session.closed':
        if (this.running) this.scheduleReconnect(lane);
        break;
      case 'error':
        if (isQuotaError(ev.error)) this.fail(new Error(QUOTA_MESSAGE));
        else this.cb.onError(new Error(ev.error?.message || '동시통역 오류'));
        break;
      default:
        break;
    }
  }

  append(lane, field, delta) {
    if (!delta) return;
    const now = Date.now();
    let block = lane.block;
    const tooLong = block && field === 'tr' && block.tr.length >= LONG_BLOCK && /[.?!。？！]["')\]]?\s*$/.test(block.tr);
    // 화자가 쉬지 않고 언어를 바꾸면(영어→한국어) 새 문단으로 나눈다
    const deltaLang = field === 'src' && delta.trim().length >= 2 ? detectLang(delta) : null;
    const langSwitch = block && deltaLang && block.srcLang && deltaLang !== block.srcLang;
    if (!block || now - block.lastAt > GAP_MS || tooLong || langSwitch) {
      this.closeBlock(lane);
      block = lane.block = {
        id: `f${now}-${this.seq++}`, ts: now, lastAt: now,
        dir: null, src: '', tr: '', srcFinal: false, final: false, visible: false,
      };
    }
    block[field] += delta;
    block.lastAt = now;
    if (field === 'src' && block.src.trim().length >= 4) block.srcLang = detectLang(block.src);
    this.updateVisibility(lane, block);

    clearTimeout(lane.gapTimer);
    lane.gapTimer = setTimeout(() => this.closeBlock(lane), GAP_MS);
  }

  updateVisibility(lane, block) {
    const srcLang = detectLang(block.src);
    if (srcLang) block.dir = directionFor(srcLang);
    else if (!block.dir) block.dir = lane.target === 'ko' ? 'en2ko' : 'ko2en';

    // 원문이 이미 이 세션의 출력 언어라면(=같은 말 반복, 또는 걸러낼 다른 언어) 숨긴다.
    // 방향을 고정하고 "다른 언어 걸러내기"를 끈 경우에만 모두 보여준다.
    const showAll = this.lanes.length === 1 && this.settings.filterOther === false;
    const show = showAll || (srcLang !== null && srcLang !== lane.target);
    if (show) {
      block.visible = true;
      this.cb.onSegment(block);
    } else if (block.visible) {
      block.visible = false;
      this.cb.onRemove(block.id);
    }
    lane.suppressed = !show;
    this.updateMute(lane);
  }

  closeBlock(lane) {
    const block = lane.block;
    if (!block) return;
    lane.block = null;
    clearTimeout(lane.gapTimer);
    if (!block.visible) return;
    if (!block.src.trim() && !block.tr.trim()) {
      this.cb.onRemove(block.id);
      return;
    }
    block.srcFinal = true;
    block.final = true;
    block.src = block.src.trim();
    block.tr = block.tr.trim();
    this.cb.onSegment(block);
  }

  updateMute(lane) {
    lane.audio.muted = !this.tts || !!lane.suppressed;
  }
}

function makeAudio() {
  const audio = document.createElement('audio');
  audio.autoplay = true;
  audio.playsInline = true;
  audio.muted = true;
  audio.hidden = true;
  document.body.appendChild(audio);
  return audio;
}
