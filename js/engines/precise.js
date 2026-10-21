// 정밀 모드: OpenAI 실시간 음성인식(원문 스트리밍) → 문장이 끝나면 GPT가 용어 사전을 반영해 번역(스트리밍)

import { createClientSecret, connectRealtime, streamText } from '../openai.js';
import { VoiceActivity } from '../vad.js';
import { detectLang, directionFor, targetOf, LANG_NAMES } from '../lang.js';

const CLIENT_VAD_MODELS = new Set(['gpt-live-transcribe']); // 서버 VAD를 지원하지 않아 직접 끊어줘야 하는 모델

export class PreciseEngine {
  constructor({ settings, glossary, stream, audioCtx, onSegment, onRemove, onStatus, onError, onLevel }) {
    this.kind = 'precise';
    this.settings = settings;
    this.glossary = glossary;
    this.stream = stream;
    this.audioCtx = audioCtx;
    this.cb = { onSegment, onRemove, onStatus, onError, onLevel };
    this.segs = new Map();     // item_id -> segment
    this.history = [];         // 번역 문맥용 최근 원문
    this.seq = 0;
    this.gen = 0;
    this.running = false;
    this.clientVad = CLIENT_VAD_MODELS.has(settings.sttModel);
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
    const transcription = { model: s.sttModel };

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
      this.cb.onError(err);
      // 키 오류 같은 설정 문제는 재시도해도 소용없다
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        this.running = false;
        this.cb.onStatus('error');
      } else {
        this.scheduleReconnect();
      }
    }
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

    const context = this.history.slice(-4).join('\n');
    this.history.push(seg.src);
    if (this.history.length > 20) this.history.shift();

    const input = context
      ? `<context>\n${context}\n</context>\n<translate>\n${seg.src}\n</translate>`
      : `<translate>\n${seg.src}\n</translate>`;

    try {
      seg.tr = await streamText({
        apiKey: this.settings.apiKey,
        model: this.settings.mtModel,
        instructions: this.instructions(targetOf(seg.dir)),
        input,
        onDelta: (text) => {
          seg.tr = text;
          this.cb.onSegment(seg);
        },
      });
    } catch (err) {
      seg.error = true;
      this.cb.onError(err);
    }
    seg.final = true;
    this.segs.delete(seg.itemId);
    this.cb.onSegment(seg);
  }

  instructions(target) {
    const lang = LANG_NAMES[target];
    const lines = [
      'You are an expert simultaneous interpreter at a live corporate event: lectures by a speaker from the foreign headquarters and role-play sessions among Korean participants.',
      `Translate the text inside <translate> into ${lang}. Output ONLY the translation, with no quotes, labels, notes or explanations.`,
      '',
      'Rules:',
      '- Convey the meaning faithfully and naturally, the way a skilled interpreter would say it out loud. Prefer short, clear sentences.',
      '- The text comes from live speech recognition and may contain recognition errors, fillers or cut-off fragments. Infer the intended meaning from the context. Drop fillers (um, uh, you know, 어, 음, 그).',
      '- If the text is a fragment, translate it as a fragment. Never add content that was not said.',
      '- <context> holds the previous lines for reference only. Never translate or repeat it.',
      `- If the text is already in ${lang}, output it unchanged (fix obvious recognition errors only).`,
      '- Keep names, numbers, dates, units and brand names accurate.',
      target === 'ko'
        ? '- Korean output: natural spoken Korean suitable for a lecture, polite style (합니다/해요체). Avoid translationese.'
        : '- English output: natural, professional spoken English that a native speaker would use.',
    ];

    if (this.glossary.length) {
      lines.push('', 'Glossary (always use these translations; a term mapped to itself must be kept as-is):');
      for (const { en, ko } of this.glossary) lines.push(`- ${en} ⇄ ${ko}`);
    }
    if (this.settings.topic) {
      lines.push('', `Event context: ${this.settings.topic.trim()}`);
    }
    return lines.join('\n');
  }
}
