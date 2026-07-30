import axios from 'axios';

import { createLogger } from './logger';
import type { NotifyLevel, NotifyPayload, OrchestratorConfig } from './types';

const log = createLogger('notify');

const COLORS: Record<NotifyLevel, number> = {
  start: 0x5865f2, // 블루 - Step 시작
  progress: 0x9b59b6, // 퍼플 - 검수 진행 중
  success: 0x2ecc71, // 그린 - 성공/커밋
  warning: 0xf1c40f, // 옐로 - 컴파일 에러/재시도
  critical: 0xe74c3c, // 레드 - 사람 개입 요청
  info: 0x95a5a6,
};

const EMOJI: Record<NotifyLevel, string> = {
  start: '🚀',
  progress: '🎮',
  success: '✅',
  warning: '⚠️',
  critical: '🚨',
  info: 'ℹ️',
};

const MAX_FIELD_VALUE = 1000;
const MAX_DESCRIPTION = 3800;

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 20)}\n… (생략됨)`;
}

export class Notifier {
  private readonly webhookUrl: string;

  private readonly projectName: string;

  constructor(config: OrchestratorConfig, projectName: string) {
    this.webhookUrl = config.discordWebhookUrl;
    this.projectName = projectName;
  }

  get enabled(): boolean {
    return this.webhookUrl.length > 0;
  }

  /** Discord 전송 실패가 오케스트레이션을 중단시키지 않도록 항상 예외를 흡수한다. */
  async send(payload: NotifyPayload): Promise<void> {
    const emoji = EMOJI[payload.level];
    const consoleLine = `${emoji} ${payload.title}${payload.description ? ` - ${payload.description.split('\n')[0]}` : ''}`;

    if (payload.level === 'critical') log.error(consoleLine);
    else if (payload.level === 'warning') log.warn(consoleLine);
    else log.info(consoleLine);

    if (!this.enabled) return;

    const embed = {
      title: `${emoji} ${payload.title}`,
      description: payload.description ? truncate(payload.description, MAX_DESCRIPTION) : undefined,
      color: COLORS[payload.level],
      fields: (payload.fields ?? []).slice(0, 25).map((field) => ({
        name: truncate(field.name, 200),
        value: truncate(field.value || '-', MAX_FIELD_VALUE),
        inline: field.inline ?? false,
      })),
      footer: { text: payload.footer ?? this.projectName },
      timestamp: new Date().toISOString(),
    };

    try {
      await axios.post(
        this.webhookUrl,
        { username: 'Cursor AutoWork', embeds: [embed] },
        { timeout: 10_000, headers: { 'Content-Type': 'application/json' } },
      );
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      log.warn(`Discord 알림 전송 실패${status ? ` (HTTP ${status})` : ''}: ${(error as Error).message}`);
    }
  }

  stepStart(stepId: number, total: number, title: string, task: string, attempt: number): Promise<void> {
    return this.send({
      level: 'start',
      title: `Step ${stepId}/${total} 시작 - ${title}`,
      description: truncate(task, 1500),
      fields: [{ name: '시도', value: `${attempt}회차`, inline: true }],
    });
  }

  validating(stepId: number, phase: string): Promise<void> {
    return this.send({
      level: 'progress',
      title: `Step ${stepId} 검수 진행 중`,
      description: phase,
    });
  }

  stepSuccess(
    stepId: number,
    title: string,
    commitHash: string | null,
    changedFiles: string[],
    durationMs: number,
  ): Promise<void> {
    return this.send({
      level: 'success',
      title: `Step ${stepId} 완료 - ${title}`,
      description: commitHash ? `커밋 \`${commitHash}\` 생성 완료` : '검수 통과 (자동 커밋 비활성화)',
      fields: [
        { name: '변경 파일', value: changedFiles.slice(0, 15).join('\n') || '없음' },
        { name: '소요 시간', value: `${Math.round(durationMs / 1000)}초`, inline: true },
      ],
    });
  }

  stepRetry(stepId: number, attempt: number, maxRetries: number, feedback: string): Promise<void> {
    return this.send({
      level: 'warning',
      title: `Step ${stepId} 검수 실패 - 재수정 지시 (${attempt}/${maxRetries})`,
      description: `\`\`\`\n${truncate(feedback, 1500)}\n\`\`\``,
    });
  }

  humanNeeded(stepId: number, title: string, reason: string): Promise<void> {
    return this.send({
      level: 'critical',
      title: `Step ${stepId} 최대 재시도 초과 - 사람 개입 필요`,
      description: `**${title}**\n\n\`\`\`\n${truncate(reason, 1500)}\n\`\`\``,
      footer: '오케스트레이터가 중단되었습니다. 수동 확인 후 재실행하세요.',
    });
  }

  pipelineDone(project: string, completed: number, total: number, durationMs: number): Promise<void> {
    return this.send({
      level: 'success',
      title: '전체 파이프라인 완료',
      description: `${project} 프로젝트의 모든 Step 이 완료되었습니다.`,
      fields: [
        { name: '완료 Step', value: `${completed}/${total}`, inline: true },
        { name: '총 소요 시간', value: `${Math.round(durationMs / 60_000)}분`, inline: true },
      ],
    });
  }
}
