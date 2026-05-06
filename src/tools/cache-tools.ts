import * as fs from 'fs';

import { z } from 'zod';

import { errorResponse, textResponse } from './ssh-helpers.js';
import type { CacheToolsContext } from './ssh-types.js';

export function registerCacheTools(context: CacheToolsContext): void {
  context.server.tool(
    'getCachedOutput',
    'Gets cached output from a previous command execution.',
    {
      cacheId: z.string(),
      option: z.enum(['full', 'last', 'save']).default('full'),
      lineCount: z.number().optional(),
      filePath: z.string().optional(),
    },
    async ({ cacheId, option, lineCount, filePath }) => {
      try {
        const cached = context.outputCacheService.getCachedOutput(cacheId);
        if (!cached) {
          return errorResponse(`缓存 ${cacheId} 不存在或已过期`);
        }

        if (option === 'save') {
          if (!filePath) {
            return errorResponse('保存文件时需要提供filePath参数');
          }

          fs.writeFileSync(filePath, context.outputCacheService.getFullOutput(cacheId) || '');
          return textResponse(`输出已保存到 ${filePath}`);
        }

        const output = option === 'last'
          ? context.outputCacheService.getLastLines(cacheId, lineCount || 100) || ''
          : context.outputCacheService.getFullOutput(cacheId) || '';

        return textResponse(output);
      } catch (error) {
        return errorResponse(`获取缓存输出时出错: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  );

  context.server.tool('getCacheStats', 'Gets cache statistics.', {}, () => {
    const stats = context.outputCacheService.getStats();
    return textResponse(`缓存统计:\n总条目: ${stats.total}\n活跃: ${stats.active}\n过期: ${stats.expired}`);
  });

  context.server.tool('clearCache', 'Clears all cached outputs.', {}, () => {
    context.outputCacheService.clearAll();
    return textResponse('所有缓存已清空');
  });
}
