// 문장 번역: Google 번역(무료, 키 불필요) 또는 GPT(API 키 필요, 용어 사전·문맥 반영)

import { streamText, ApiError } from './openai.js';
import { LANG_NAMES } from './lang.js';

// ---------- Google 번역 (무료) ----------
// 공식 유료 API가 아니라 브라우저 확장 프로그램들이 쓰는 공개 주소라서, 많이 쓰면 잠시 막힐 수 있다.

export async function googleTranslate({ text, from, to, glossary = [], signal }) {
  const prepared = applyGlossary(text, from, glossary);
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + `&sl=${from}&tl=${to}&q=${encodeURIComponent(prepared)}`;
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError('번역 서버에 연결하지 못했습니다. 인터넷 연결을 확인해주세요.', 0);
  }
  if (res.status === 429) throw new ApiError('무료 번역 사용량이 잠시 초과됐습니다. 잠시 후 자동으로 다시 시도합니다.', 429);
  if (!res.ok) throw new ApiError(`번역 실패 (HTTP ${res.status})`, res.status);
  const data = await res.json();
  return (data?.[0] || []).map((part) => part?.[0] || '').join('').trim();
}

// 용어 사전: 번역 전에 원문의 용어를 원하는 번역어로 바꿔 넣는다.
// (영어 문장 속 한글 단어, 한국어 문장 속 영어 단어는 번역기가 그대로 둔다)
export function applyGlossary(text, from, glossary) {
  const pairs = glossary
    .map(({ en, ko }) => (from === 'en' ? { find: en, put: ko } : { find: ko, put: en }))
    .filter(({ find, put }) => find && put && find !== put)
    .sort((a, b) => b.find.length - a.find.length);

  let out = text;
  for (const { find, put } of pairs) {
    const escaped = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 영어는 단어 단위로만 바꾼다 (예: "line"이 "downline" 안에서 바뀌지 않게)
    const pattern = /^[A-Za-z0-9]/.test(find) ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])` : escaped;
    out = out.replace(new RegExp(pattern, 'gi'), put);
  }
  return out;
}

// ---------- GPT 번역 ----------

// GPT가 "다른 언어라서 번역하지 않음"을 알릴 때 쓰는 표시
export const SKIP = '<SKIP>';
export const isSkip = (text) => text.trim().startsWith(SKIP);

// filterSource: 'ko' | 'en' 이면 그 언어가 아닌 말(음성인식기가 억지로 받아 적은 다른 언어)은 SKIP을 돌려준다
export async function gptTranslate({ apiKey, model, text, target, glossary = [], topic = '', context = [], filterSource = null, onDelta }) {
  const recent = context.slice(-4).join('\n');
  const input = recent
    ? `<context>\n${recent}\n</context>\n<translate>\n${text}\n</translate>`
    : `<translate>\n${text}\n</translate>`;
  return streamText({
    apiKey,
    model,
    instructions: gptInstructions(target, glossary, topic, filterSource),
    input,
    // SKIP 표시가 만들어지는 도중("<SK")에는 화면에 내보내지 않는다
    onDelta: onDelta && ((partial) => { if (!partial.trimStart().startsWith('<')) onDelta(partial); }),
  });
}

function gptInstructions(target, glossary, topic, filterSource) {
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
    filterSource
      ? `- If the text is in ${lang} already, output exactly ${SKIP}.`
      : `- If the text is already in ${lang}, output it unchanged (fix obvious recognition errors only).`,
    '- Keep names, numbers, dates, units and brand names accurate.',
    target === 'ko'
      ? '- Korean output: natural spoken Korean suitable for a lecture, polite style (합니다/해요체). Avoid translationese.'
      : '- English output: natural, professional spoken English that a native speaker would use.',
  ];

  if (filterSource) {
    const src = LANG_NAMES[filterSource];
    lines.push(
      '',
      'Language filter:',
      `- The text comes from a speech recognizer listening ONLY for ${src}. When people speak another language, the recognizer still forces it into ${src}, producing text that is not genuine ${src} speech.`,
      filterSource === 'ko'
        ? '- Example: English speech written phonetically in Hangul, like "굿모닝 에브리원 투데이 아이 원트 투 토크" (good morning everyone today I want to talk). Korean loanwords used inside a normal Korean sentence (e.g. "미팅 일정을 체크해 주세요") ARE genuine Korean.'
        : '- Example: Korean speech forced into English-sounding words, like "and young has say oh so come on yeah". Real English, even casual or fragmentary, IS genuine English.',
      `- If the text is clearly NOT genuine ${src} speech, output exactly ${SKIP} and nothing else. If unsure, translate it.`,
    );
  }

  if (glossary.length) {
    lines.push('', 'Glossary (always use these translations; a term mapped to itself must be kept as-is):');
    for (const { en, ko } of glossary) lines.push(`- ${en} ⇄ ${ko}`);
  }
  if (topic) lines.push('', `Event context: ${topic.trim()}`);
  return lines.join('\n');
}
