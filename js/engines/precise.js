// 정밀 모드: OpenAI 실시간 음성인식(원문 스트리밍) → 문장이 끝나면 GPT가 용어 사전을 반영해 번역(스트리밍)

import { createClientSecret, connectRealtime, checkCredits, isQuotaError, QUOTA_MESSAGE } from '../openai.js';
import { gptTranslate } from '../translate.js';
import { VoiceActivity } from '../vad.js';
import { detectLang, directionFor, targetOf } from '../lang.js';

const CLIENT_VAD_MODELS = new Set(['gpt-live-transcribe']); // 서버 VAD를 지원하지 않아 직접 끊어줘야 하는 모델
const FALLBACK_STT_MODEL = 'gpt-4o-transcribe';           // 브라우저(WebRTC) 연결이 확인된 안정형 모델

export class PreciseEngine {
  constructor({ settings, glossary, stream, audioCtx, onSegment, onRemove, onStatus, onError, onNotice, onLevel }) {
    this.kind = 'precise';
    this.settings = settings;
    this.glossary = glossary;
    this.stream = stream;
    this.audioCtx = audioCtx;
    this.cb = { onSegment, onRemove, onStatus, onError, onNotice, onLevel };
    this.segs = new Map();     // item_id -> segment
    this.history = [];         // 번역 문맥용 최근 원문
    this.seq = 0;
    this.gen = 0;
    this.running = false;
    this.setSttModel(settings.sttModel);
  }

  setSttModel(model) {
    this.sttModel = model;
    this.clientVad = CLIENT_VAD_MODELS.has(model);
  }

  fail(err) {
    if (!this.running) return;
    this.running = false;
    this.cb.onError(err);
    this.cb.onStatus('error');
  }

  async start() {
    this.running = true;
    this.vad = new VoiceActivity(this.audioCtx, this.stream, {
      silenceMs: this.settings.silenceMs,
      onLevel: this.cb.onLevel,
      onSpeechEnd: () => {
        if (this.clientVad) this.conn?.send({ type: 'input_audio_buffer.commit' });
      },
    });
    this.vad.start();
    await this.connect();
  }

  stop() {
    this.running = false;
    clearTimeout(this.retryTimer);
    this.vad?.stop();
    const conn = this.conn;
    this.conn = null;
    conn?.send({ type: 'input_audio_buffer.commit' });
    // 마지막 문장의 인식 결과가 도착할 시간을 잠깐 준 뒤 닫는다
    setTimeout(() => {
      this.gen++;
      conn?.close();
      for (const seg of this.segs.values()) this.flushUnfinished(seg);
    }, 1500);
  }

  // ---------- 연결 ----------

  sessionConfig() {
    const s = this.settings;
    const languages = s.direction === 'auto' ? ['en', 'ko'] : s.direction === 'en2ko' ? ['en'] : ['ko'];
    const transcription = { model: this.sttModel };

    if (this.clientVad) {
      transcription.languages = languages;
      const keywords = this.keywords();
      if (keywords.length) transcription.keywords = keywords;
    } else if (languages.length === 1) {
      transcription.language = languages[0];
    }

    const prompt = this.sttPrompt();
    if (prompt) transcription.prompt = prompt;

    return {
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'transcription',
        audio: {
          input: {
            noise_reduction: { type: s.noise },
            transcription,
            turn_detection: this.clientVad
              ? null
              : { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: s.silenceMs },
          },
        },
      },
    };
  }

  keywords() {
    const words = new Set();
    for (const { en, ko } of this.glossary) {
      for (const w of [en, ko]) {
        const clean = w.replace(/[<>\r\n]/g, '').trim();
        if (clean && clean.length <= 60) words.add(clean);
      }
    }
    return [...words].slice(0, 100);
  }

  sttPrompt() {
    const parts = [];
    if (this.settings.topic) parts.push(this.settings.topic.trim());
    if (!this.clientVad && this.glossary.length) {
      parts.push('Terms: ' + this.glossary.map((g) => g.en).join(', '));
    }
    return parts.join('\n').slice(0, 600);
  }

  async connect() {
    const gen = ++this.gen;
    this.cb.onStatus('connecting');
    try {
      const secret = await createClientSecret(this.settings.apiKey, '/realtime/client_secrets', this.sessionConfig());
      if (gen !== this.gen) return;
      const conn = await connectRealtime({
        secret,
        callsPath: '/realtime/calls',
        track: this.stream.getAudioTracks()[0],
        onEvent: (ev) => gen === this.gen && this.handleEvent(ev),
        onStateChange: (state) => gen === this.gen && this.handleState(state),
      });
      if (gen !== this.gen || !this.running) { conn.close(); return; }
      this.conn = conn;
      this.retries = 0;
      this.cb.onStatus('listening');
    } catch (err) {
      if (gen !== this.gen) return;
      // 키 오류·잔액 없음 같은 문제는 재시도해도 소용없다
      if (err.fatal) return this.fail(err);
      if (err.status >= 500) return this.recoverFromServerError(err);
      this.cb.onError(err);
      this.scheduleReconnect();
    }
  }

  // 실시간 연결이 500으로 실패하면: 잔액 부족인지 먼저 확인하고, 아니면 안정형 인식 모델로 바꿔 다시 연결한다
  async recoverFromServerError(err) {
    try {
      await checkCredits(this.settings.apiKey);
    } catch (creditErr) {
      if (creditErr.fatal) return this.fail(creditErr);
    }
    if (!this.running) return;
    if (this.sttModel !== FALLBACK_STT_MODEL) {
      this.cb.onNotice?.(`${this.sttModel} 연결에 실패해 ${FALLBACK_STT_MODEL} 모델로 전환합니다.`);
      this.setSttModel(FALLBACK_STT_MODEL);
      this.connect();
      return;
    }
    this.cb.onError(err);
    this.scheduleReconnect();
  }

  handleState(state) {
    if (!this.running) return;
    if (state === 'failed' || state === 'closed' || state === 'channel-closed') {
      this.scheduleReconnect();
    } else if (state === 'disconnected') {
      // 잠깐 끊겼다 돌아오는 경우가 많으니 조금 기다린다
      clearTimeout(this.discTimer);
      this.discTimer = setTimeout(() => {
        if (this.conn?.pc.connectionState === 'disconnected') this.scheduleReconnect();
      }, 4000);
    }
  }

  scheduleReconnect() {
    if (!this.running) return;
    this.gen++;
    this.conn?.close();
    this.conn = null;
    for (const seg of this.segs.values()) this.flushUnfinished(seg);
    this.retries = (this.retries || 0) + 1;
    const delay = Math.min(10000, 500 * 2 ** Math.min(this.retries, 5));
    this.cb.onStatus('reconnecting');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.running && this.connect(), delay);
  }

  // ---------- 이벤트 ----------

  handleEvent(ev) {
    switch (ev.type) {
      case 'conversation.item.input_audio_transcription.delta': {
        const seg = this.segFor(ev.item_id);
        seg.src += ev.delta || '';
        this.updateDirection(seg);
        this.cb.onSegment(seg);
        break;
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const text = (ev.transcript || '').trim();
        const seg = this.segs.get(ev.item_id);
        if (!text) {
          if (seg) this.removeSeg(seg);
          break;
        }
        const target = seg || this.segFor(ev.item_id);
        target.src = text;
        this.updateDirection(target);
        target.srcFinal = true;
        this.cb.onSegment(target);
        this.translate(target);
        break;
      }
      case 'conversation.item.input_audio_transcription.failed': {
        const seg = this.segs.get(ev.item_id);
        if (seg) this.flushUnfinished(seg);
        break;
      }
      case 'error': {
        const code = ev.error?.code || '';
        if (/commit_empty|buffer_too_small/i.test(code)) break; // 말이 없을 때 commit한 경우
        if (isQuotaError(ev.error)) {
          this.fail(new Error(QUOTA_MESSAGE));
          this.conn?.close();
          break;
        }
        this.cb.onError(new Error(ev.error?.message || '실시간 인식 오류'));
        break;
      }
      default:
        break;
    }
  }

  segFor(itemId) {
    let seg = this.segs.get(itemId);
    if (!seg) {
      seg = { id: `p${Date.now()}-${this.seq++}`, itemId, ts: Date.now(), dir: null, src: '', tr: '', srcFinal: false, final: false };
      this.segs.set(itemId, seg);
    }
    return seg;
  }

  removeSeg(seg) {
    this.segs.delete(seg.itemId);
    this.cb.onRemove(seg.id);
  }

  updateDirection(seg) {
    if (this.settings.direction !== 'auto') {
      seg.dir = this.settings.direction;
      return;
    }
    const lang = detectLang(seg.src);
    if (lang) seg.dir = directionFor(lang);
  }

  // 연결이 끊겨 인식 완료 이벤트를 못 받은 문장은 받은 데까지라도 번역한다
  flushUnfinished(seg) {
    if (seg.srcFinal || seg.translating) return;
    if (!seg.src.trim()) { this.removeSeg(seg); return; }
    seg.srcFinal = true;
    this.translate(seg);
  }

  // ---------- 번역 ----------

  async translate(seg) {
    if (seg.translating) return;
    seg.translating = true;
    if (!seg.dir) seg.dir = this.settings.direction === 'auto' ? 'en2ko' : this.settings.direction;

    const context = this.history.slice(-4);
    this.history.push(seg.src);
    if (this.history.length > 20) this.history.shift();

    try {
      seg.tr = await gptTranslate({
        apiKey: this.settings.apiKey,
        model: this.settings.mtModel,
        text: seg.src,
        target: targetOf(seg.dir),
        glossary: this.glossary,
        topic: this.settings.topic,
        context,
        onDelta: (text) => {
          seg.tr = text;
          this.cb.onSegment(seg);
        },
      });
    } catch (err) {
      seg.error = true;
      if (err.fatal && this.running) this.fail(err);
      else this.cb.onError(err);
    }
    seg.final = true;
    this.segs.delete(seg.itemId);
    this.cb.onSegment(seg);
  }
}
