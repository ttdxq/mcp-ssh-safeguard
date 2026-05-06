import type { SafetyCheckResult, SafetyCheckService } from '../services/safety-check-service.js';
import type {
  OperationPolicyAssessment,
  OperationRiskType,
  PendingConfirmationEntry,
} from './ssh-types.js';

interface AssessOperationPolicyOptions {
  connectionId: string;
  command: string;
  confirmation?: string;
  operationType: OperationRiskType;
  operationSummary?: string;
  pendingConfirmations: Map<string, PendingConfirmationEntry>;
  safetyCheckService: SafetyCheckService | null;
  pendingConfirmationTtlMs: number;
}

export function createPendingConfirmationKey(connectionId: string, operationType: OperationRiskType, command: string): string {
  return `${operationType}:${connectionId}:${command}`;
}

export function cleanupExpiredPendingConfirmations(pendingConfirmations: Map<string, PendingConfirmationEntry>): void {
  const now = Date.now();
  for (const [key, entry] of pendingConfirmations.entries()) {
    if (entry.expiresAt <= now) {
      pendingConfirmations.delete(key);
    }
  }
}

export function buildPendingConfirmationResponse(operationSummary: string, safetyResult: SafetyCheckResult): OperationPolicyAssessment['response'] {
  if (safetyResult.level === 'moderate') {
    return {
      content: [{
        type: 'text',
        text: `⚠️ 操作需要确认 ⚠️\n\n操作: "${operationSummary}"\n原因: ${safetyResult.reason}\n${safetyResult.suggestedAction ? `建议: ${safetyResult.suggestedAction}\n` : ''}请回复"yes"确认执行，或回复"no"取消。`,
      }],
    };
  }

  return {
    content: [{
      type: 'text',
      text: `🚨 危险操作检测 🚨\n\n操作: "${operationSummary}"\n风险等级: 危险\n原因: ${safetyResult.reason}\n${safetyResult.consequences ? `可能的后果: ${safetyResult.consequences}\n` : ''}如果确实需要执行，请再次输入完全相同的内容来确认。`,
    }],
  };
}

export async function assessOperationPolicy(options: AssessOperationPolicyOptions): Promise<OperationPolicyAssessment> {
  const {
    connectionId,
    command,
    confirmation,
    operationType,
    operationSummary = command,
    pendingConfirmations,
    safetyCheckService,
    pendingConfirmationTtlMs,
  } = options;

  cleanupExpiredPendingConfirmations(pendingConfirmations);

  const pendingKey = createPendingConfirmationKey(connectionId, operationType, command);
  const pending = pendingConfirmations.get(pendingKey);

  if (confirmation && !pending) {
    return {
      allowed: false,
      response: {
        content: [{
          type: 'text',
          text: `🚨 高风险确认请求已拒绝 🚨\n\n操作: "${operationSummary}"\n原因: 当前操作没有待确认记录，或此前未获得执行同意。系统已将本次确认内容视为高风险输入并拒绝执行。`,
        }],
        isError: true,
      },
    };
  }

  if (pending) {
    if (pending.safetyResult.level === 'dangerous') {
      if (confirmation === command) {
        pendingConfirmations.delete(pendingKey);
        return { allowed: true };
      }

      pendingConfirmations.delete(pendingKey);
      return {
        allowed: false,
        response: {
          content: [{ type: 'text', text: '危险操作确认失败。请重新输入确认内容。' }],
          isError: true,
        },
      };
    }

    if (confirmation === 'yes') {
      pendingConfirmations.delete(pendingKey);
      return { allowed: true };
    }

    pendingConfirmations.delete(pendingKey);
    return {
      allowed: false,
      response: {
        content: [{ type: 'text', text: '指令执行已取消。' }],
      },
    };
  }

  if (!safetyCheckService) {
    return { allowed: true };
  }

  let safetyResult = await safetyCheckService.checkCommandSafety(command);

  if (operationType === 'background_command') {
    if (safetyResult.level === 'safe') {
      safetyResult = {
        ...safetyResult,
        level: 'moderate',
        reason: '后台持续执行会放大指令影响范围，即使原始指令较安全也需要人工确认。',
        suggestedAction: '确认该命令适合长期重复执行，并检查执行频率与影响范围。',
      };
    } else if (safetyResult.level === 'moderate') {
      safetyResult = {
        ...safetyResult,
        reason: `${safetyResult.reason} 后台持续执行会进一步放大风险。`,
        suggestedAction: safetyResult.suggestedAction || '仅在明确需要时执行，并确保频率与持续时间受控。',
      };
    }
  }

  if (safetyResult.level === 'safe') {
    return { allowed: true };
  }

  pendingConfirmations.set(pendingKey, {
    command,
    safetyResult,
    expiresAt: Date.now() + pendingConfirmationTtlMs,
  });

  return {
    allowed: false,
    response: buildPendingConfirmationResponse(operationSummary, safetyResult),
  };
}
