import { registerFileTransferBasicTools } from './file-transfer-basic-tools.js';
import { registerFileTransferBatchTools } from './file-transfer-batch-tools.js';
import { registerFileTransferQueryTools } from './file-transfer-query-tools.js';
import type { FileToolsContext } from './ssh-types.js';

export function registerFileTools(context: FileToolsContext): void {
  registerFileTransferBasicTools(context);
  registerFileTransferBatchTools(context);
  registerFileTransferQueryTools(context);
}
