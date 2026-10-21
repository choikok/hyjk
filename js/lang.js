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
