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
      timeout: 30000, // [优化] 延长至30秒，防止复杂Prompt分析超时
      maxRetries: 1,
    });
  }

  /**
   * 检查指令安全性
   */
  async checkCommandSafety(command: string): Promise<SafetyCheckResult> {
    // 1. 检查缓存
    const cached = this.getCachedResult(command);
    if (cached) {
      return cached;
    }

    try {
      // 2. 优先使用AI进行安全检查
      const result = await this.analyzeCommandWithAI(command);
      this.cacheResult(command, result);
      return result;
    } catch (error) {
      console.error('AI安全检查失败 (网络或解析错误):', error);
      // 3. 降级方案：使用本地规则引擎
      console.warn('正在使用快速安全检查作为降级方案');
      const quickResult = this.quickCheck(command);
      this.cacheResult(command, quickResult);
      return quickResult;
    }
  }

  /**
   * 使用OpenAI API分析指令
   */
  private async analyzeCommandWithAI(command: string): Promise<SafetyCheckResult> {
    // [优化] 更新后的Prompt，采用白名单策略，支持相对路径和归档操作
    const prompt = `你是一个Linux安全审计专家，服务于**开发和运维人员**。
你的任务是判断指令是否对系统构成**实质性威胁**。请采用**“白名单宽容策略”**：如果是常见的开发/文件操作，且不涉及系统关键目录，一律视为 Safe。

指令: ${command}

请按照以下JSON格式回复：
{
  "level": "safe|moderate|dangerous",
  "reason": "简短的分类原因",
  "suggestedAction": "建议操作（可选，仅moderate/dangerous需要）",
  "consequences": "可能的后果（仅dangerous需要）"
}

安全级别定义（请严格匹配）：
- safe (无需确认，直接通过):
    1. **文件系统常规操作**: 在当前/用户目录下进行的创建、复制、移动、重命名 (mkdir, touch, cp, mv, rm 临时文件)。
    2. **归档与压缩**: 打包或解压文件 (tar, zip, unzip, gzip, gunzip, rar)。
    3. **内容查看与搜索**: 只读操作 (ls, cat, grep, find, tail, less)。
    4. **环境构建与安装**: 标准的包管理或语言包安装 (sudo apt/yum install, pip/npm/yarn install, go get)。
    5. **开发工具**: 编译器运行、脚本执行、Git操作 (python, go run, make, git status/add/commit)。
    6. **权限授予**: 为脚本赋予执行权限 (chmod +x)。
    7. **服务管理**: 重启非核心服务 (systemctl restart docker/nginx)。
- moderate (需要确认，存在风险):
    1. **修改系统配置**: 编辑 /etc/, /boot/, /usr/bin/ 等敏感路径下的文件。
    2. **全局权限放开**: 使用 chmod 777 或 -R 递归修改大量文件权限。
    3. **网络架构变更**: 修改防火墙(iptables)、网卡配置、Host文件。
    4. **高资源消耗**: 可能导致机器卡死的压力测试指令。
- dangerous (禁止或高危):
    1. **系统毁灭**: rm -rf / (或根目录下的关键文件夹), 格式化磁盘(mkfs, fdisk)。
    2. **恶意特征**: 反弹Shell (bash -i), 隐蔽下载执行 (curl ... | bash), 清除审计日志。
    3. **设备重写**: dd if=/dev/zero of=/dev/sda。

**核心判断逻辑**:
1. 检查**路径**: 操作的是 test2 (相对路径) 还是 /etc/test (绝对/系统路径)？相对路径通常是 Safe。
2. 检查**动作**: 是“日常办公/开发”还是“修改操作系统内核/配置”？
3. 对于 tar, mkdir, touch, git 等指令，只要不覆盖系统关键文件，**必须**返回 safe。

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
      temperature: 0.1, // 低温度保证确定性
      max_tokens: 300,
    });

    const content = response.choices[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response from OpenAI API');
    }

    return this.parseAIResponse(content);
  }

  /**
   * 解析AI响应 - [优化] 三级容错机制
   */
  private parseAIResponse(content: string): SafetyCheckResult {
    // 1. 第一层：尝试标准 JSON 解析（需先清洗 Markdown）
    try {
      // 移除可能存在的 ```json 代码块标记
      const cleanContent = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
      return JSON.parse(cleanContent);
    } catch (e) {
      // ignore, continue to level 2
    }

    // 2. 第二层：尝试正则提取整个 JSON 对象
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (e) {
      // ignore, continue to level 3
    }

    // 3. 第三层：直接匹配关键字段（保底策略）
    // 防止因为多了个逗号导致无法解析，但其实AI已经给出了 level
    const levelMatch = content.match(/"level"\s*:\s*"(safe|moderate|dangerous)"/i);
    
    if (levelMatch) {
      const level = levelMatch[1].toLowerCase() as 'safe' | 'moderate' | 'dangerous';
      
      // 尝试提取 reason，如果没有则给默认值
      const reasonMatch = content.match(/"reason"\s*:\s*"([^"]*)"/);
      const reason = reasonMatch ? reasonMatch[1] : "JSON格式轻微受损，系统已自动提取核心安全评级";

      console.warn(`AI响应JSON解析失败，已降级为正则关键词提取。提取结果: ${level}`);

      return {
        level: level,
        reason: reason,
        suggestedAction: level !== 'safe' ? '建议人工复核 (系统自动提取)' : undefined
      };
    }

    // 4. 彻底失败：只能返回 moderate 让用户人工确认
    console.error('AI返回内容完全无法解析:', content);
    return {
      level: 'moderate',
      reason: 'AI响应格式严重错误，无法识别安全等级',
      suggestedAction: '请必须人工确认此指令'
    };
  }

  /**
   * 快速安全检查（基于规则的本地降级方案）
   */
  quickCheck(command: string): SafetyCheckResult {
    const cmd = command.trim().toLowerCase();
    const baseCmd = cmd.split(/\s+/)[0];

    // [优化] 扩充安全指令白名单，包含常用开发工具
    const safeCommands = [
      // 基础查询
      'ls', 'cat', 'grep', 'find', 'pwd', 'whoami', 'who', 'w',
      'ps', 'top', 'htop', 'free', 'df', 'du', 'uname', 'hostname',
      'date', 'cal', 'which', 'whereis', 'echo', 'printenv', 'env',
      'head', 'tail', 'more', 'less', 'man',
      // 开发与构建工具
      'git', 'node', 'npm', 'yarn', 'pnpm', 'python', 'python3', 'pip',
      'java', 'javac', 'go', 'docker', 'docker-compose', 'make', 'cmake',
      // 文件处理（结合相对路径判断逻辑会更复杂，这里简单列入白名单，依靠dangerousPatterns拦截）
      'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'rar', '7z',
      'touch', 'mkdir' // mkdir 在本地规则中通常是安全的，除非配合绝对路径（下面未实现复杂路径检测，但对于降级方案足够）
    ];

    // 危险指令模式（高优先级匹配）
    const dangerousPatterns = [
      /rm\s+-rf\s+\//,         // 删根
      /rm\s+-rf\s+\*/,         // 删所有
      /dd\s+if=\/dev\/zero/,   // 覆写磁盘
      /mkfs\./,                // 格式化
      /fdisk\s+\/dev/,         // 分区
      /parted\s+\/dev/,
      /chmod\s+777\s+-R/,      // 递归满权限
      /chmod\s+-R\s+777/,
      /:\(\)\{\s*:\|\:&\s*\};/, // Fork bomb
      /wget.*\|\s*bash/,       // 管道执行脚本
      /curl.*\|\s*bash/,
      />\s*\/dev\/sda/,        // 重定向写设备
      /\/etc\/(shadow|passwd|sudoers)/ // 涉及敏感文件
    ];

    // 1. 优先检查危险模式
    for (const pattern of dangerousPatterns) {
      if (pattern.test(cmd)) {
        return {
          level: 'dangerous',
          reason: '指令匹配已知的危险模式 (本地规则)',
          consequences: '可能导致数据丢失或系统损坏'
        };
      }
    }

    // 2. 检查白名单
    if (safeCommands.includes(baseCmd)) {
      return {
        level: 'safe',
        reason: '常用开发或只读指令 (本地白名单)'
      };
    }

    // 3. 一般指令 (Moderate)
    const moderateCommands = [
      'rm', 'cp', 'mv', 'ln', 'chmod', 'chown',
      'apt-get', 'apt', 'yum', 'dnf', 'pacman',
      'systemctl', 'service', 'journalctl', 'kill', 'killall',
      'ssh', 'scp', 'rsync'
    ];

    if (moderateCommands.includes(baseCmd)) {
      return {
        level: 'moderate',
        reason: '指令会修改文件、配置或服务状态 (本地规则)',
        suggestedAction: '请确认操作目标'
      };
    }

    // 4. 未知指令 -> Moderate
    return {
      level: 'moderate',
      reason: '无法确定指令安全性 (未知指令)',
      suggestedAction: '请确认指令意图'
    };
  }

  // --- 缓存管理逻辑保持不变 ---

  private getCachedResult(command: string): SafetyCheckResult | null {
    const cached = this.cache.get(command);
    if (!cached) { return null; }
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(command);
      return null;
    }
    return cached.result;
  }

  private cacheResult(command: string, result: SafetyCheckResult): void {
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.removeOldestEntry();
    }
    this.cache.set(command, { result, timestamp: Date.now() });
  }

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

  clearCache(): void {
    this.cache.clear();
  }
}