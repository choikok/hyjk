// 한국어/영어 판별과 방향 관련 도우미

const HANGUL = /[ㄱ-ㆎ가-힣]/g;
const LATIN = /[A-Za-z]/g;

// 텍스트에 한글이 더 많으면 'ko', 알파벳이 더 많으면 'en', 판단 불가면 null
export function detectLang(text) {
  const ko = (text.match(HANGUL) || []).length;
  const en = (text.match(LATIN) || []).length;
  if (ko === 0 && en === 0) return null;
  // 한글 한 글자가 영어 단어 하나 정도의 정보량이라 가중치를 둔다
  return ko * 2.5 >= en ? 'ko' : 'en';
}

// 한국어 음성인식기가 영어를 소리 나는 대로 한글로 적은 문장인지 추정한다 (예: "굿모닝 에브리원 투데이")
// 진짜 한국어는 단어 끝에 조사·어미가 거의 항상 붙고, 한글로 적은 영어는 그게 없고 "스·트·크" 같은 음절이 많다.
const KO_ENDING = /(은|는|을|를|에|에서|의|도|로|으로|와|과|요|다|까|죠|네|고|서|면|는데|지만|니까|께서|한테|부터|까지|처럼|보다|이랑|하고)$/;
const TRANSLIT_SYLLABLE = /[스트크즈츠드브프쓰]/;
const TRANSLIT_WORDS = new Set(['더', '앤드', '앤', '오브', '투', '이즈', '댓', '디스', '위', '유', '아이', '잇', '왓', '위드', '포', '인', '온', '앳', '비', '해브', '캔', '윌', '두', '노', '예스', '쏘', '벗', '오어', '이프', '웬', '데이', '데어', '히어', '마이', '유어', '아워', '뎀', '히즈', '잇츠', '아임', '위아', '돈트', '어바웃', '굿', '쏘우', '애즈', '올', '하우', '웨어', '와이', '후', '어', '렛츠', '유어', '아일', '위윌']);

export function looksLikeTransliteratedEnglish(text) {
  const words = text.replace(/[.,!?~…]/g, ' ').split(/\s+/).filter((w) => /[가-힣]/.test(w));
  if (words.length < 4) return false;
  const withEnding = words.filter((w) => KO_ENDING.test(w)).length;
  const functionWords = words.filter((w) => TRANSLIT_WORDS.has(w)).length;
  const translit = words.filter((w) => TRANSLIT_WORDS.has(w) || TRANSLIT_SYLLABLE.test(w)).length;
  // 외래어 명사만 나열한 한국어("프로젝트 스케줄 체크")와 구분하려고 영어 기능어(더·투·이즈…)가 있어야 영어로 본다
  return withEnding / words.length < 0.15 && functionWords >= 2 && translit / words.length >= 0.4;
}

export function directionFor(srcLang) {
  return srcLang === 'ko' ? 'ko2en' : 'en2ko';
}

export function targetOf(dir) {
  return dir === 'ko2en' ? 'en' : 'ko';
}

export const DIRECTION_LABELS = {
  auto: '자동 · 한↔영',
  en2ko: '영어 → 한국어',
  ko2en: '한국어 → 영어',
};

export const LANG_NAMES = { en: 'English', ko: 'Korean (한국어)' };
