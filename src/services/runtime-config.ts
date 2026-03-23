import * as os from 'os';
import * as path from 'path';

const DEFAULT_DATA_PATH = path.join(os.homedir(), '.mcp-ssh');

export interface DataPathResolution {
  dataPath: string;
  warning?: string;
}

export function isInsecureDockerCredentialPersistenceEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ALLOW_INSECURE_DOCKER_CREDENTIALS === 'true';
}

export function resolveDataPath(env: NodeJS.ProcessEnv = process.env): DataPathResolution {
  const dataPath = env.DATA_PATH?.trim();
  const legacyDataPath = env.SSH_DATA_PATH?.trim();

  if (dataPath) {
    if (legacyDataPath && legacyDataPath !== dataPath) {
      return {
        dataPath,
        warning: 'DATA_PATH and SSH_DATA_PATH are both set; using DATA_PATH.'
      };
    }

    return { dataPath };
  }

  if (legacyDataPath) {
    return {
      dataPath: legacyDataPath,
      warning: 'SSH_DATA_PATH is deprecated; use DATA_PATH instead.'
    };
  }

  return { dataPath: DEFAULT_DATA_PATH };
}
