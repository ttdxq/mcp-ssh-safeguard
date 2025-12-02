export interface CachedOutput {
  id: string;
  command: string;
  fullOutput: string;
  timestamp: number;
  connectionId: string;
}

export class OutputCacheService {
  private cache: Map<string, CachedOutput> = new Map();
  private readonly MAX_CACHE_SIZE = 50;
  private readonly CACHE_TTL = 30 * 60 * 1000; // 30分钟

  /**
   * 缓存输出
   */
  cacheOutput(command: string, output: string, connectionId: string): string {
    const id = this.generateCacheId();
    const cached: CachedOutput = {
      id,
      command,
      fullOutput: output,
      timestamp: Date.now(),
      connectionId
    };

    // 如果缓存已满，删除最旧的条目
    if (this.cache.size >= this.MAX_CACHE_SIZE) {
      this.removeOldestEntry();
    }

    this.cache.set(id, cached);
    return id;
  }

  /**
   * 获取缓存的输出
   */
  getCachedOutput(id: string): CachedOutput | null {
    const cached = this.cache.get(id);
    if (!cached) {
      return null;
    }

    // 检查是否过期
    if (Date.now() - cached.timestamp > this.CACHE_TTL) {
      this.cache.delete(id);
      return null;
    }

    return cached;
  }

  /**
   * 获取最后N行输出
   */
  getLastLines(id: string, lineCount: number = 100): string | null {
    const cached = this.getCachedOutput(id);
    if (!cached) {
      return null;
    }

    const lines = cached.fullOutput.split('\n');
    const lastLines = lines.slice(-lineCount);
    return lastLines.join('\n');
  }

  /**
   * 获取完整输出
   */
  getFullOutput(id: string): string | null {
    const cached = this.getCachedOutput(id);
    return cached ? cached.fullOutput : null;
  }

  /**
   * 删除缓存条目
   */
  removeCachedOutput(id: string): boolean {
    return this.cache.delete(id);
  }

  /**
   * 清空过期缓存
   */
  cleanupExpired(): void {
    const now = Date.now();
    for (const [id, cached] of this.cache.entries()) {
      if (now - cached.timestamp > this.CACHE_TTL) {
        this.cache.delete(id);
      }
    }
  }

  /**
   * 清空所有缓存
   */
  clearAll(): void {
    this.cache.clear();
  }

  /**
   * 获取缓存统计
   */
  getStats(): {
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
   * 生成缓存ID
   */
  private generateCacheId(): string {
    return `cache_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * 删除最旧的缓存条目
   */
  private removeOldestEntry(): void {
    let oldestId: string | null = null;
    let oldestTime = Infinity;

    for (const [id, cached] of this.cache.entries()) {
      if (cached.timestamp < oldestTime) {
        oldestTime = cached.timestamp;
        oldestId = id;
      }
    }

    if (oldestId) {
      this.cache.delete(oldestId);
    }
  }
}