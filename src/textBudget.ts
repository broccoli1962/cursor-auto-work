import { createLogger } from './logger';

const log = createLogger('budget');

/**
 * 한도를 넘기면 앞 70% + 뒤쪽을 남기고 중간을 생략한다.
 * 조용히 자르지 않고 경고를 남긴다.
 */
export function budgetText(text: string, maxChars: number, label: string): string {
  if (maxChars < 80 || text.length <= maxChars) return text;

  const omitted = text.length - maxChars;
  log.warn(`${label} ${text.length}자 → ${maxChars}자. 중간 ${omitted}자를 생략합니다.`);

  const marker = `\n\n[...${label} 중간 ${omitted}자 생략. 원본을 직접 읽으세요...]\n\n`;
  const usable = maxChars - marker.length;
  const head = Math.max(40, Math.floor(usable * 0.7));
  const tail = Math.max(40, usable - head);
  return `${text.slice(0, head)}${marker}${text.slice(-tail)}`;
}
