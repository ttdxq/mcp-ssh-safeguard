import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import SSHConfig from 'ssh-config';
import { LineType } from 'ssh-config';
import type { Section } from 'ssh-config';

export interface SshConfigEntry {
  alias: string;
  hostName: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyCommand?: string;
  forwardAgent?: boolean;
}

export interface SshConfigImportResult {
  entries: SshConfigEntry[];
  errors: string[];
  configPath: string;
}

function untildify(filePath: string): string {
  if (filePath.startsWith('~')) {
    return filePath.replace(/^~(?=$|\/|\\)/, os.homedir());
  }
  return filePath;
}

function resolveIdentityFile(raw: unknown): string[] {
  if (!raw) return [];
  const files = Array.isArray(raw) ? raw : [raw];
  return files.map(f => untildify(String(f)));
}

function getUserSshConfigPath(): string {
  return path.join(os.homedir(), '.ssh', 'config');
}

function getSystemSshConfigPath(): string {
  if (process.platform === 'win32') {
    const programData = process.env.ALLUSERSPROFILE || process.env.PROGRAMDATA || 'C:\\ProgramData';
    return path.join(programData, 'ssh', 'ssh_config');
  }
  return '/etc/ssh/ssh_config';
}

export function parseSshConfig(configPath?: string): SshConfigImportResult {
  const filePath = configPath ?? getUserSshConfigPath();
  const errors: string[] = [];
  const entries: SshConfigEntry[] = [];

  if (!fs.existsSync(filePath)) {
    return {
      entries: [],
      errors: [`SSH config file not found: ${filePath}`],
      configPath: filePath,
    };
  }

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    return {
      entries: [],
      errors: [`Failed to read SSH config: ${err instanceof Error ? err.message : String(err)}`],
      configPath: filePath,
    };
  }

  let parsed: ReturnType<typeof SSHConfig.parse>;
  try {
    parsed = SSHConfig.parse(content);
  } catch (err) {
    return {
      entries: [],
      errors: [`Failed to parse SSH config: ${err instanceof Error ? err.message : String(err)}`],
      configPath: filePath,
    };
  }

  for (const section of parsed) {
    if (section.type !== LineType.DIRECTIVE || (section as Section).param !== 'Host') {
      continue;
    }

    const hostSection = section as Section;
    const hostPattern = String(hostSection.value);

    if (hostPattern === '*' || hostPattern.includes('?')) {
      continue;
    }

    try {
      const computed = parsed.compute(hostPattern, { ignoreCase: true });

      const entry: SshConfigEntry = {
        alias: hostPattern,
        hostName: String(computed.HostName ?? hostPattern),
        user: computed.User ? String(computed.User) : undefined,
        port: computed.Port ? parseInt(String(computed.Port), 10) : undefined,
        identityFiles: resolveIdentityFile(computed.IdentityFile),
        proxyCommand: computed.ProxyCommand ? String(computed.ProxyCommand) : undefined,
        forwardAgent: computed.ForwardAgent === 'yes',
      };

      if (!Number.isNaN(entry.port)) {
        entries.push(entry);
      }
    } catch (err) {
      errors.push(`Failed to compute config for Host ${hostPattern}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { entries, errors, configPath: filePath };
}

export function formatSshConfigEntries(result: SshConfigImportResult): string {
  if (result.entries.length === 0 && result.errors.length === 0) {
    return `未找到 SSH 配置文件: ${result.configPath}\n\n请确保 ~/.ssh/config 文件存在。`;
  }

  let output = `SSH 配置文件: ${result.configPath}\n`;
  output += `找到 ${result.entries.length} 个主机配置\n\n`;

  for (const entry of result.entries) {
    output += `[${entry.alias}]\n`;
    output += `   主机名: ${entry.hostName}\n`;
    if (entry.user) output += `   用户: ${entry.user}\n`;
    if (entry.port && entry.port !== 22) output += `   端口: ${entry.port}\n`;
    if (entry.identityFiles.length > 0) {
      output += `   密钥: ${entry.identityFiles.join(', ')}\n`;
    }
    if (entry.proxyCommand) output += `   代理: ${entry.proxyCommand}\n`;
    if (entry.forwardAgent) output += `   转发代理: 是\n`;
    output += '\n';
  }

  if (result.errors.length > 0) {
    output += `警告:\n`;
    for (const error of result.errors) {
      output += `   - ${error}\n`;
    }
  }

  return output;
}

export function getAvailableConfigPaths(): { user: string; system: string } {
  return {
    user: getUserSshConfigPath(),
    system: getSystemSshConfigPath(),
  };
}
