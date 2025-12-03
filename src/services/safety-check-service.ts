import OpenAI from 'openai';

export interface SafetyCheckResult {
  level: 'safe' | 'moderate' | 'dangerous';
  reason: string;
  suggestedAction?: string;
  consequences?: string;
}

interface CachedSafetyResult {
  result: SafetyCheckResult;
  timestamp: number;
}

export class SafetyCheckService {
  private openai: OpenAI;
  private cache: Map<string, CachedSafetyResult> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存
  private readonly MAX_CACHE_SIZE = 100;

  constructor(apiKey: string, apiBase?: string, private model: string = 'gpt-3.5-turbo') {
    this.openai = new OpenAI({
      apiKey,
      baseURL: apiBase || 'https://api.openai.com/v1',
      timeout: 5000, // 5秒超时
      maxRetries: 1,
    });
  }

  /**
   * 检查指令安全性
   */
  async checkCommandSafety(command: string): Promise<SafetyCheckResult> {
    // 先检查缓存
    const cached = this.getCachedResult(command);
    if (cached) {
      return cached;
    }

    try {
      // 优先使用AI进行安全检查
      const result = await this.analyzeCommandWithAI(command);
      this.cacheResult(command, result);
      return result;
    } catch (error) {
      console.error('AI安全检查失败:', error);
      // AI检查失败时，使用快速安全检查作为降级方案
      console.error('使用快速安全检查作为降级方案');
      const quickResult = this.quickCheck(command);
      this.cacheResult(command, quickResult);
      return quickResult;
    }
  }

  /**
   * 使用OpenAI API分析指令
   */
  private async analyzeCommandWithAI(command: string): Promise<SafetyCheckResult> {
    const prompt = `你是一个Linux系统安全专家。请分析以下指令的安全性，并将其分类为safe（安全）、moderate（一般）或dangerous（危险）。

指令: ${command}

请按照以下JSON格式回复：
{
  "level": "safe|moderate|dangerous",
  "reason": "分类原因",
  "suggestedAction": "建议操作（可选）",
  "consequences": "可能的后果（危险指令必填）"
}

安全级别定义：
- safe: 只读操作，不会修改系统（如：ls, cat, grep, pwd, whoami）
- moderate: 会修改文件或系统配置，但风险可控（如：touch, mkdir, apt-get install）
- dangerous: 可能导致数据丢失或系统损坏（如：rm -rf, dd, fdisk）

请只返回JSON，不要其他解释。`;

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        {
          role: 'system',
          content: 'You are a Linux system security expert. Analyze command safety and respond with JSON only.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI API');
    }

    return this.parseAIResponse(content);
  }

  /**
   * 解析AI响应
   */
  private parseAIResponse(content: string): SafetyCheckResult {
    try {
      // 尝试直接解析JSON
      return JSON.parse(content);
    } catch (error) {
      // 如果直接解析失败，尝试提取JSON部分
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          return JSON.parse(jsonMatch[0]);
        } catch (e) {
          // 如果还是失败，使用默认响应
          console.warn('无法解析AI响应，使用默认安全级别');
        }
      }
    }

    // 默认返回moderate级别
    return {
      level: 'moderate',
      reason: '无法准确评估指令安全性，需要用户确认',
      suggestedAction: '请确认是否继续执行'
    };
  }

  /**
   * 从缓存获取结果
   */
  private getCachedResult(command: string): SafetyCheckResult | null {
    const cached = this.cache.get(command);
    if (!cached) {
      return null;
    }

    // 检查是否过期
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(command);
      return null;
    }

    return cached.result;
  }

  /**
   * 缓存结果
   */
  private cacheResult(command: string, result: SafetyCheckResult): void {
    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.removeOldestEntry();
    }

    this.cache.set(command, {
      result,
      timestamp: Date.now()
    });
  }

  /**
   * 删除最旧的缓存条目
   */
  private removeOldestEntry(): void {
    let oldestCommand: string | null = null;
    let oldestTime = Infinity;

    for (const [cmd, cached] of this.cache.entries()) {
      if (cached.timestamp < oldestTime) {
        oldestTime = cached.timestamp;
        oldestCommand = cmd;
      }
    }

    if (oldestCommand) {
      this.cache.delete(oldestCommand);
    }
  }

  /**
   * 清空过期缓存
   */
  cleanupExpiredCache(): void {
    const now = Date.now();
    for (const [command, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.CACHE_TTL) {
        this.cache.delete(command);
      }
    }
  }

  /**
   * 清空所有缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计
   */
  getCacheStats(): {
    total: number;
    expired: number;
    active: number;
  } {
    const now = Date.now();
    let expired = 0;
    
    for (const cached of this.cache.values()) {
      if (now - cached.timestamp > this.CACHE_TTL) {
        expired++;
      }
    }

    return {
      total: this.cache.size,
      expired,
      active: this.cache.size - expired
    };
  }

  /**
   * 快速安全检查（不使用AI，基于规则）
   */
  quickCheck(command: string): SafetyCheckResult {
    const cmd = command.trim().toLowerCase();

    // 安全指令（只读）
    const safeCommands = [
      'ls', 'cat', 'grep', 'find', 'pwd', 'whoami', 'who', 'w',
      'ps', 'top', 'htop', 'free', 'df', 'du', 'uname', 'hostname',
      'date', 'cal', 'which', 'whereis', 'echo', 'printenv', 'env'
    ];

    // 危险指令模式
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,
      /rm\s+-rf\s+\*/,
      /dd\s+if=\/dev\/zero/,
      /mkfs\./,
      /fdisk\s+\/dev/,
      /parted\s+\/dev/,
      /chmod\s+777\s+-R/,
      /chmod\s+-R\s+777/,
      /:\(\)\{\s*:\|\:&\s*\};/, // fork bomb
      /wget.*\|\s*bash/,
      /curl.*\|\s*bash/,
      />\s*\/dev\/sda/,
      />\s*\/dev\/hda/
    ];

    // 检查是否为安全指令
    const baseCmd = cmd.split(/\s+/)[0];
    if (safeCommands.includes(baseCmd)) {
      // 检查是否包含危险参数
      if (dangerousPatterns.some(pattern => pattern.test(cmd))) {
        return {
          level: 'dangerous',
          reason: '指令包含危险的参数组合',
          consequences: '可能导致数据丢失或系统损坏'
        };
      }
      return {
        level: 'safe',
        reason: '只读操作，不会修改系统'
      };
    }

    // 检查危险模式
    for (const pattern of dangerousPatterns) {
      if (pattern.test(cmd)) {
        return {
          level: 'dangerous',
          reason: '指令匹配已知的危险模式',
          consequences: '可能导致数据丢失或系统损坏'
        };
      }
    }

    // 一般指令
    const moderateCommands = [
      'touch', 'mkdir', 'rmdir', 'rm', 'cp', 'mv', 'ln',
      'apt-get', 'yum', 'dnf', 'pacman', 'pip', 'npm',
      'systemctl', 'service', 'journalctl'
    ];

    if (moderateCommands.includes(baseCmd)) {
      return {
        level: 'moderate',
        reason: '指令会修改文件或系统配置',
        suggestedAction: '请确认操作目标'
      };
    }

    // 未知指令，返回moderate
    return {
      level: 'moderate',
      reason: '无法确定指令安全性',
      suggestedAction: '请确认指令意图'
    };
  }
}