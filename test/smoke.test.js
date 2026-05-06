import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';

import { OutputCacheService } from '../dist/services/output-cache-service.js';
import { isInsecureDockerCredentialPersistenceEnabled, resolveDataPath } from '../dist/services/runtime-config.js';

test('resolveDataPath prefers DATA_PATH and falls back to legacy SSH_DATA_PATH', () => {
  assert.deepEqual(resolveDataPath({ DATA_PATH: '/preferred' }), {
    dataPath: '/preferred'
  });

  assert.deepEqual(resolveDataPath({ SSH_DATA_PATH: '/legacy' }), {
    dataPath: '/legacy',
    warning: 'SSH_DATA_PATH is deprecated; use DATA_PATH instead.'
  });

  assert.deepEqual(resolveDataPath({ DATA_PATH: '/preferred', SSH_DATA_PATH: '/legacy' }), {
    dataPath: '/preferred',
    warning: 'DATA_PATH and SSH_DATA_PATH are both set; using DATA_PATH.'
  });
});

test('output cache returns the requested trailing lines', () => {
  const service = new OutputCacheService();
  const cacheId = service.cacheOutput('demo', 'one\ntwo\nthree', 'connection-1');

  assert.equal(service.getLastLines(cacheId, 2), 'two\nthree');
  assert.equal(service.getFullOutput(cacheId), 'one\ntwo\nthree');
});

test('docker credential persistence stays opt-in', () => {
  assert.equal(isInsecureDockerCredentialPersistenceEnabled({ ALLOW_INSECURE_DOCKER_CREDENTIALS: false }), false);
  assert.equal(isInsecureDockerCredentialPersistenceEnabled({ ALLOW_INSECURE_DOCKER_CREDENTIALS: true }), true);
});

test('ssh MCP source registers cache tools', async () => {
  const source = await readFile(new URL('../src/tools/ssh.ts', import.meta.url), 'utf8');
  assert.match(source, /this\.registerCacheTools\(\);/);
  assert.match(source, /beforeCapture = await this\.sshService\.executeCommand\(/);
  assert.match(source, /const hasCommandOutput = Boolean\(result\.stdout \|\| result\.stderr\);/);
  assert.match(source, /loadConfig\(\)/);
  assert.match(source, /resolveSafetyCheckConfig/);
  assert.match(source, /private async assessOperationPolicy\(/);
  assert.match(source, /createPendingConfirmationKey\(connectionId, operationType, command\)/);
  assert.match(source, /if \(confirmation && !pending\) \{/);
  assert.match(source, /高风险确认请求已拒绝/);
  assert.match(source, /if \(!this\.safetyCheckService\) \{/);

  assert.match(source, /operationType === 'background_command'/);
  assert.match(source, /后台持续执行会放大指令影响范围/);
  assert.match(source, /confirmation: z\.string\(\)\.optional\(\)\.describe\("Confirmation string required for commands that need explicit approval"\)/);
  assert.match(source, /type OperationRiskType = 'command' \| 'background_command' \| 'file_upload' \| 'file_download' \| 'batch_file_upload' \| 'batch_file_download' \| 'tunnel_create' \| 'terminal_write';/);
  assert.match(source, /operationType: 'file_upload'/);
  assert.match(source, /operationType: 'file_download'/);
  assert.match(source, /operationType: 'batch_file_upload'/);
  assert.match(source, /operationType: 'batch_file_download'/);
  assert.match(source, /operationType: 'tunnel_create'/);
  assert.match(source, /operationType: 'terminal_write'/);
  assert.match(source, /Confirmation string required for risky transfers/);
  assert.match(source, /Confirmation string required for tunnel creation approval/);
  assert.match(source, /Confirmation string required for risky terminal writes/);
  assert.match(source, /upload local file \$\{localPath\} to remote path \$\{remotePath\}/);
  assert.match(source, /download remote file \$\{remotePath\} to local path \$\{savePath\}/);
  assert.match(source, /batch upload \$\{files\.length\} local files to remote destinations:/);
  assert.match(source, /batch download \$\{normalizedFiles\.length\} remote files to local destinations:/);
  assert.match(source, /create SSH tunnel from local port \$\{localPort\} to \$\{remoteHost\}:\$\{remotePort\}/);
  assert.match(source, /write terminal input to session \$\{sessionId\}: \$\{data\}/);
  assert.match(source, /connectionId: `terminal:\$\{sessionId\}`/);
});

test('safety check service sends provider-specific thinking controls', async () => {
  const source = await readFile(new URL('../src/services/safety-check-service.ts', import.meta.url), 'utf8');
  assert.match(source, /type ThinkingMode = 'disabled' \| 'enabled' \| 'auto';/);
  assert.match(source, /body:\s*{\s*\.\.\.requestBody,\s*thinking:/s);
});

test('python bridge starts node without shell mode', async () => {
  const source = await readFile(new URL('../bridging_ssh_mcp.py', import.meta.url), 'utf8');
  assert.match(source, /\["node", index_js_path\]/);
  assert.doesNotMatch(source, /shell=True/);
});

test('index source shuts down after fatal process errors', async () => {
  const source = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(source, /async function gracefulShutdown\(/);
  assert.match(source, /shutdownOnFatalError\('未捕获的异常，准备退出:'/);
  assert.match(source, /shutdownOnFatalError\('未处理的Promise拒绝，准备退出:'/);
});

test('repository standardizes on npm lockfile for installs', async () => {
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const packageJson = await readFile(new URL('../package.json', import.meta.url), 'utf8');

  assert.match(dockerfile, /COPY package\.json package-lock\.json \.\//);
  assert.match(dockerfile, /RUN npm ci/);
  assert.match(packageJson, /"packageManager": "npm@10"/);

  await assert.rejects(access(new URL('../pnpm-lock.yaml', import.meta.url)));
});
