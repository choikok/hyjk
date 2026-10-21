// 무료 모드: 브라우저 내장 음성인식(Web Speech API — 아이폰은 Siri 받아쓰기, PC 크롬은 Google 음성인식)
//          + Google 번역(무료). API 키가 있으면 GPT 번역을 고를 수도 있다.
// 내장 음성인식은 한 번에 한 언어만 듣기 때문에 자동 감지는 없고, 방향(영→한 / 한→영)을 골라서 쓴다.

import { googleTranslate, gptTranslate, isSkip } from '../translate.js';
import { targetOf, detectLang, looksLikeTransliteratedEnglish } from '../lang.js';

const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const IS_STANDALONE = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

const START_TIMEOUT_MS = 6000;  // start() 후 반응이 없으면 다시 시작 (아이폰에서 가끔 멈춤)
const STOP_TIMEOUT_MS = 2500;   // stop() 후 끝나지 않으면 강제로 끊는다
const MAX_CHARS = 220;          // 문장이 이보다 길어지면 끊어서 먼저 번역한다

export function speechRecognitionSupported() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

export class FreeEngine {
  static needsMicStream = false; // 음성인식이 마이크를 직접 연다 (아이폰에서 두 곳이 동시에 마이크를 열면 충돌)

  constructor({ settings, glossary, onSegment, onRemove, onStatus, onError, onNotice }) {
    this.kind = 'free';
    this.settings = settings;
    this.glossary = glossary;
    this.cb = { onSegment, onRemove, onStatus, onError, onNotice };
    this.dir = settings.direction === 'ko2en' ? 'ko2en' : 'en2ko';
    this.srcLang = this.dir === 'ko2en' ? 'ko' : 'en';   // 듣고 있는 언어
    this.filter = settings.filterOther !== false;          // 다른 언어로 들린 말은 건너뛰기
    this.useGpt = settings.freeTranslator === 'gpt' && !!settings.apiKey;
    this.history = [];
    this.seq = 0;
    this.live = null;          // 지금 인식 중인(아직 확정 안 된) 문장
    this.quickFails = 0;
    this.running = false;
  }

  async start() {
    this.SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!this.SR) {
      this.running = true;
      this.fail(new Error('이 브라우저는 무료 음성인식을 지원하지 않습니다. 아이폰은 Safari, PC는 Chrome 또는 Edge를 사용해주세요.'));
      return;
    }
    this.running = true;
    this.cb.onStatus('connecting');
    this.listen();
  }

  stop({ immediate = false } = {}) {
    this.running = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.idleTimer);
    const rec = this.rec;
    if (!rec) return;
    if (immediate) {
      this.rec = null;
      try { rec.abort(); } catch { /* 이미 멈춤 */ }
      this.finishLive();
      return;
    }
    try { rec.stop(); } catch { /* 이미 멈춤 */ }
    // 마지막 문장의 결과를 잠깐 기다렸다가 강제로 끊는다
    setTimeout(() => {
      if (this.rec === rec) {
        try { rec.abort(); } catch { /* 이미 멈춤 */ }
        this.finishLive();
      }
    }, STOP_TIMEOUT_MS);
  }

  fail(err) {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.restartTimer);
    clearTimeout(this.idleTimer);
    try { this.rec?.abort(); } catch { /* 이미 멈춤 */ }
    this.cb.onError(err);
    this.cb.onStatus('error');
  }

  // ---------- 음성인식 ----------

  listen() {
    if (!this.running) return;
    const rec = new this.SR();
    rec.lang = this.dir === 'ko2en' ? 'ko-KR' : 'en-US';
    // 아이폰은 연속 모드에 버그가 있어서 한 문장씩 듣고 매번 다시 시작한다
    rec.continuous = !IS_IOS;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    this.rec = rec;
    const done = new Set();      // 이미 확정 처리한 결과 번호
    const startedAt = Date.now();
    let gotResult = false;
    let started = false;

    const guard = setTimeout(() => {
      // 시작 신호가 오지 않으면 끊고 다시 시작
      if (this.rec === rec && !started && !gotResult) { try { rec.abort(); } catch { /* 무시 */ } }
    }, START_TIMEOUT_MS);

    rec.onstart = () => {
      started = true;
      clearTimeout(guard);
      if (this.running) this.cb.onStatus('listening');
    };

    rec.onresult = (e) => {
      gotResult = true;
      clearTimeout(guard);
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const text = result[0]?.transcript || '';
        if (result.isFinal) {
          if (!done.has(i)) {
            done.add(i);
            this.commit(text);
          }
        } else {
          interim += text;
        }
      }
      this.setInterim(interim);

      // 말이 멈췄는데 확정이 늦거나, 문장이 너무 길면 이번 인식을 끝내서 확정시킨다
      clearTimeout(this.idleTimer);
      if (interim.trim()) {
        const idleMs = IS_IOS ? Math.max(900, this.settings.silenceMs + 300) : 2500;
        if (interim.length > MAX_CHARS) this.requestStop(rec);
        else this.idleTimer = setTimeout(() => this.requestStop(rec), idleMs);
      }
    };

    rec.onerror = (e) => this.handleError(e.error);

    rec.onend = () => {
      clearTimeout(guard);
      clearTimeout(this.idleTimer);
      if (this.rec !== rec) return;
      this.finishLive();
      this.rec = null;
      if (!this.running) return;

      // 결과 없이 금방 끝나는 일이 반복되면 잠깐 쉬었다가 다시 시작한다
      const quick = !gotResult && Date.now() - startedAt < 1500;
      this.quickFails = quick ? this.quickFails + 1 : 0;
      const delay = this.quickFails >= 3 ? Math.min(5000, 500 * this.quickFails) : 100;
      if (this.quickFails >= 3) this.cb.onStatus('reconnecting');
      this.restartTimer = setTimeout(() => this.listen(), delay);
    };

    try {
      rec.start();
    } catch (err) {
      clearTimeout(guard);
      this.rec = null;
      this.restartTimer = setTimeout(() => this.listen(), 1000);
    }
  }

  requestStop(rec) {
    if (this.rec !== rec) return;
    try { rec.stop(); } catch { /* 이미 멈춤 */ }
    setTimeout(() => {
      if (this.rec === rec) { try { rec.abort(); } catch { /* 무시 */ } }
    }, STOP_TIMEOUT_MS);
  }

  handleError(code) {
    switch (code) {
      case 'no-speech':
      case 'aborted':
        return; // 말이 없었거나 우리가 끊은 것 → onend에서 다시 시작
      case 'network':
        this.cb.onNotice?.('음성인식 서버 연결이 불안정합니다. 다시 연결하는 중...');
        this.cb.onStatus('reconnecting');
        return;
      case 'not-allowed':
      case 'service-not-allowed':
        this.fail(new Error(permissionHelp()));
        return;
      case 'audio-capture':
        this.fail(new Error('마이크를 사용할 수 없습니다. 다른 앱이 마이크를 쓰고 있지 않은지 확인해주세요.'));
        return;
      case 'language-not-supported':
        this.fail(new Error('이 기기에서 해당 언어의 음성인식을 지원하지 않습니다. 아이폰은 설정 → 일반 → 키보드에 한국어·영어 키보드와 받아쓰기를 켜주세요.'));
        return;
      default:
        this.cb.onNotice?.(`음성인식 오류: ${code}`);
    }
  }

  // ---------- 문장 ----------

  newSeg() {
    return { id: `w${Date.now()}-${this.seq++}`, ts: Date.now(), dir: this.dir, src: '', tr: '', srcFinal: false, final: false };
  }

  setInterim(text) {
    if (!text.trim()) return;
    if (!this.live) this.live = this.newSeg();
    this.live.src = text.trim();
    // 다른 언어 글자로 적히는 중이면 화면에 띄우지 않는다 (말이 이어지며 언어가 바뀌면 다시 보인다)
    if (this.filter && this.isOtherLanguage(this.live.src, false)) {
      this.cb.onRemove(this.live.id);
      return;
    }
    this.cb.onSegment(this.live);
  }

  commit(text) {
    const src = text.trim();
    const seg = this.live || this.newSeg();
    this.live = null;
    if (!src) {
      this.cb.onRemove(seg.id);
      return;
    }
    seg.src = src;
    if (this.filter && this.isOtherLanguage(src, true)) {
      this.skip(seg);
      return;
    }
    seg.srcFinal = true;
    this.cb.onSegment(seg);
    this.translate(seg);
  }

  // 듣고 있는 언어가 아닌 말인지: ① 다른 언어 글자로 적혔거나 ② (한국어 모드) 영어를 소리대로 한글로 적은 경우.
  // ②는 문장이 끝났을 때만 본다. GPT 번역을 쓰면 ②는 GPT가 더 정확하게 판단하므로 맡긴다.
  isOtherLanguage(text, final) {
    const lang = detectLang(text);
    if (lang && lang !== this.srcLang) return true;
    return final && !this.useGpt && this.srcLang === 'ko' && looksLikeTransliteratedEnglish(text);
  }

  skip(seg) {
    this.cb.onRemove(seg.id);
    if (!this.skipNoticeShown) {
      this.skipNoticeShown = true;
      const other = this.srcLang === 'ko' ? '영어' : '한국어';
      this.cb.onNotice?.(`${other}로 들린 말은 번역하지 않고 건너뜁니다. (설정 → "다른 언어 걸러내기")`);
    }
  }

  // 인식이 확정 없이 끝났으면 들은 데까지 확정한다
  finishLive() {
    if (this.live) this.commit(this.live.src);
  }

  async translate(seg) {
    const from = seg.dir === 'ko2en' ? 'ko' : 'en';
    const to = targetOf(seg.dir);
    const context = this.history.slice(-4);

    try {
      if (this.useGpt) {
        try {
          seg.tr = await gptTranslate({
            apiKey: this.settings.apiKey,
            model: this.settings.mtModel,
            text: seg.src,
            target: to,
            glossary: this.glossary,
            topic: this.settings.topic,
            context,
            filterSource: this.filter ? from : null,
            onDelta: (text) => { seg.tr = text; this.cb.onSegment(seg); },
          });
          if (isSkip(seg.tr)) {
            this.skip(seg);
            return;
          }
        } catch (err) {
          // GPT를 못 쓰면(잔액 없음 등) 무료 번역으로 바꿔서 계속한다
          this.useGpt = false;
          this.cb.onNotice?.(`GPT 번역을 쓸 수 없어 Google 번역으로 전환합니다. (${err.message})`);
          seg.tr = await googleTranslate({ text: seg.src, from, to, glossary: this.glossary });
        }
      } else {
        seg.tr = await googleTranslate({ text: seg.src, from, to, glossary: this.glossary });
      }
    } catch (err) {
      seg.error = true;
      this.cb.onError(err);
    }
    this.history.push(seg.src);
    if (this.history.length > 20) this.history.shift();
    seg.final = true;
    this.cb.onSegment(seg);
  }
}

function permissionHelp() {
  if (!IS_IOS) return '마이크 권한이 없습니다. 주소창 왼쪽의 자물쇠 아이콘에서 마이크를 허용해주세요.';
  return [
    '음성인식 권한이 없습니다.',
    '① 아이폰 설정 → 앱 → Safari → 마이크를 "허용" 또는 "묻기"로,',
    '② 설정 → 일반 → 키보드 → "받아쓰기 활성화"를 켜주세요.',
    IS_STANDALONE ? '③ 그래도 안 되면 홈 화면 앱 대신 Safari에서 주소를 직접 열어 사용해주세요.' : '',
  ].join(' ');
}
