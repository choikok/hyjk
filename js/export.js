// 기록 내보내기 (TXT / CSV). 아이폰에서는 공유 시트, PC에서는 파일 다운로드로 전달한다.

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function fmtDateTime(ts) {
  return new Date(ts).toLocaleString('ko-KR', { hour12: false });
}

function dirLabel(dir) {
  return dir === 'ko2en' ? 'KO→EN' : 'EN→KO';
}

export function exportTxt(session) {
  const lines = [
    'HYJK 통역 기록',
    `제목: ${session.title}`,
    `일시: ${fmtDateTime(session.startedAt)}${session.endedAt ? ` ~ ${fmtTime(session.endedAt)}` : ''}`,
    `엔진: ${session.engine === 'fast' ? '초고속' : '정밀'}`,
    `문장 수: ${session.items.length}`,
    '',
    '='.repeat(40),
    '',
  ];
  for (const it of session.items) {
    lines.push(`[${fmtTime(it.ts)}] ${dirLabel(it.dir)}`);
    lines.push(`원문: ${it.src}`);
    lines.push(`번역: ${it.tr}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function exportCsv(session) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['시간', '방향', '원문', '번역'].map(esc).join(',')];
  for (const it of session.items) {
    rows.push([fmtTime(it.ts), dirLabel(it.dir), it.src, it.tr].map(esc).join(','));
  }
  // 엑셀에서 한글이 깨지지 않도록 BOM을 붙인다
  return '﻿' + rows.join('\r\n');
}

export async function deliverFile(content, filename, type) {
  const file = new File([content], filename, { type });
  const isTouch = matchMedia('(pointer: coarse)').matches;
  if (isTouch && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: filename });
    return;
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
