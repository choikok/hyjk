// 간단한 음성 구간 감지(VAD). 말이 끝난 시점을 찾아 문장 단위로 끊어주고, 마이크 레벨도 알려준다.
// 주변 소음 수준(noise floor)을 계속 추적해서 강연장처럼 시끄러운 곳에서도 동작하게 한다.

const TICK_MS = 40;
const START_MS = 120;          // 이만큼 이어져야 말 시작으로 본다
const SOFT_MAX_MS = 12000;     // 문장이 길면 짧은 쉼(250ms)에서도 끊는다
const SOFT_GAP_MS = 250;
const HARD_MAX_MS = 25000;     // 쉬지 않고 말해도 이 길이에서는 강제로 끊는다

export class VoiceActivity {
  constructor(ctx, stream, { silenceMs = 700, onSpeechStart, onSpeechEnd, onLevel } = {}) {
    this.ctx = ctx;
    this.silenceMs = silenceMs;
    this.onSpeechStart = onSpeechStart;
    this.onSpeechEnd = onSpeechEnd;
    this.onLevel = onLevel;

    this.source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);

    this.floor = -60;
    this.speaking = false;
    this.aboveMs = 0;
    this.silentMs = 0;
    this.speechMs = 0;
  }

  start() {
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    try { this.source.disconnect(); } catch { /* 이미 해제됨 */ }
  }

  tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(sum / this.buf.length);
    const db = 20 * Math.log10(rms + 1e-9);

    // 소음 수준: 내려갈 때는 빠르게, 올라갈 때는 아주 천천히 따라간다
    const rate = db < this.floor ? 0.2 : 0.004;
    this.floor = Math.max(-90, Math.min(-25, this.floor + (db - this.floor) * rate));

    const startThr = Math.max(this.floor + 9, -62);
    const keepThr = Math.max(this.floor + 5, -66);

    this.onLevel?.(Math.max(0, Math.min(1, (db - this.floor) / 30)));

    if (!this.speaking) {
      this.aboveMs = db > startThr ? this.aboveMs + TICK_MS : 0;
      if (this.aboveMs >= START_MS) {
        this.speaking = true;
        this.speechMs = this.aboveMs;
        this.silentMs = 0;
        this.onSpeechStart?.();
      }
      return;
    }

    this.speechMs += TICK_MS;
    this.silentMs = db < keepThr ? this.silentMs + TICK_MS : 0;

    if (this.silentMs >= this.silenceMs) this.end('silence');
    else if (this.speechMs >= SOFT_MAX_MS && this.silentMs >= SOFT_GAP_MS) this.end('long');
    else if (this.speechMs >= HARD_MAX_MS) this.end('max');
  }

  end(reason) {
    this.speaking = false;
    this.aboveMs = 0;
    this.silentMs = 0;
    this.speechMs = 0;
    this.onSpeechEnd?.(reason);
  }
}
