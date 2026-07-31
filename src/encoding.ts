import { execSync } from 'node:child_process';

/**
 * 자식 프로세스 콘솔 출력 디코딩 유틸.
 *
 * Windows 는 cmd.exe / 시스템 도구의 오류 메시지를 UTF-8 이 아닌 로컬 코드페이지
 * (한국어 949, 일본어 932 등)로 내보낸다. 이를 그대로 'utf8' 로 읽으면
 * 로그에 U+FFFD 로 치환되어 복구 불가능한 깨진 문자열이 남는다.
 */

/** Windows 콘솔 코드페이지 → WHATWG 인코딩 라벨 */
const CODEPAGE_LABELS: Record<string, string> = {
  '65001': 'utf-8',
  '1200': 'utf-16le',
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
  '437': 'ibm866',
  '850': 'windows-1252',
};

let originalCodepage: string | null = null;
let codepageProbed = false;

/** `chcp` 출력("활성 코드 페이지: 949")에서 숫자만 뽑아낸다. */
function probeConsoleCodepage(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    const out = execSync('chcp', { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('latin1');
    return /(\d{3,5})/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * 콘솔 코드페이지를 UTF-8 로 전환한다.
 * 전환 전 원래 코드페이지를 기억해 두어야 자식 프로세스가 뱉는
 * 레거시 인코딩 메시지를 나중에 올바르게 디코딩할 수 있다.
 */
export function enableUtf8Console(): void {
  if (process.platform !== 'win32') return;

  originalCodepage = probeConsoleCodepage();
  codepageProbed = true;

  try {
    execSync('chcp 65001', { stdio: 'ignore', windowsHide: true });
  } catch {
    // 콘솔이 아닌 환경(파이프/CI)에서는 무시
  }
}

/** 로케일로 유추한 레거시 코드페이지 후보. chcp 탐지가 실패했을 때만 쓴다. */
function localeCandidates(): string[] {
  let locale = '';
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase();
  } catch {
    return [];
  }

  if (locale.startsWith('ko')) return ['euc-kr'];
  if (locale.startsWith('ja')) return ['shift_jis'];
  if (locale.startsWith('zh-tw') || locale.startsWith('zh-hk') || locale.startsWith('zh-mo')) {
    return ['big5'];
  }
  if (locale.startsWith('zh')) return ['gbk'];
  if (locale.startsWith('ru') || locale.startsWith('uk')) return ['windows-1251'];
  return [];
}

let cachedCandidates: string[] | null = null;

function decodeCandidates(): string[] {
  if (cachedCandidates) return cachedCandidates;

  if (!codepageProbed && process.platform === 'win32') {
    originalCodepage = probeConsoleCodepage();
    codepageProbed = true;
  }

  const labels: string[] = [];
  const fromCodepage = originalCodepage ? CODEPAGE_LABELS[originalCodepage] : undefined;
  if (fromCodepage && fromCodepage !== 'utf-8') labels.push(fromCodepage);
  for (const label of localeCandidates()) {
    if (!labels.includes(label)) labels.push(label);
  }
  if (process.platform === 'win32' && !labels.includes('windows-1252')) labels.push('windows-1252');

  cachedCandidates = labels;
  return labels;
}

/**
 * 버퍼를 UTF-8 로 먼저 시도하고, 실패하면 콘솔 코드페이지 후보로 재시도한다.
 * 어느 것도 맞지 않으면 바이트를 잃지 않도록 latin1 로 떨어뜨린다.
 */
export function decodeConsole(buffer: Buffer): string {
  if (buffer.length === 0) return '';

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    // 아래 후보들로 재시도
  }

  for (const label of decodeCandidates()) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(buffer);
    } catch {
      continue;
    }
  }

  return buffer.toString('latin1');
}

/**
 * 앞쪽을 잘라내며 최근 N 바이트만 유지하는 stderr 수집기.
 * 멀티바이트 문자가 청크 경계에서 쪼개져도 안전하도록 디코딩은 flush 시점에 한 번만 한다.
 */
export class ConsoleTail {
  private chunks: Buffer[] = [];

  private bytes = 0;

  constructor(private readonly maxBytes = 20_000) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      this.bytes -= this.chunks.shift()?.length ?? 0;
    }
  }

  get isEmpty(): boolean {
    return this.chunks.length === 0;
  }

  toString(): string {
    if (this.chunks.length === 0) return '';
    return decodeConsole(Buffer.concat(this.chunks));
  }
}
