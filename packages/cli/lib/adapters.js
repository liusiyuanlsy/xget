import { spawn, spawnSync } from 'node:child_process';

import { ContractError, getPlatformManifest, validateBaseUrl } from '../shared/contracts/index.js';

/* eslint-disable jsdoc/require-description, jsdoc/require-returns-description */

const ADAPTERS = new Set(['git', 'npm', 'pip']);

/**
 * @typedef {{adapter: string, baseUrl: string, env: Record<string, string>, command: string[], displayCommand: string[]}}
 *   ExecutionPlan
 */

/**
 * @typedef {{adapter: string, baseUrl: string, config: object[], executable: string, tool: {available: boolean, exitCode: number | null, output: string}, supported: boolean, network: {checked: boolean, ok: boolean | null, [key: string]: unknown}}} AdapterInspection
 */

/**
 * @param {string} adapter
 * @returns {void}
 */
function assertAdapter(adapter) {
  if (!ADAPTERS.has(adapter)) {
    throw new ContractError('UNSUPPORTED_ADAPTER', 'Supported adapters are git, npm, and pip.', 2);
  }
}

/**
 * @param {string} baseUrl
 * @returns {string}
 */
function trimBaseUrl(baseUrl) {
  return baseUrl.replace(/\/$/, '');
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactArgument(value) {
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password) {
      return `${parsed.protocol}//[credentials-redacted]${parsed.pathname}`;
    }
    for (const key of parsed.searchParams.keys()) {
      if (/token|secret|key|password|signature/i.test(key)) {
        parsed.searchParams.set(key, '[redacted]');
      }
    }
    return parsed.toString();
  } catch {
    return value;
  }
}

/**
 * @param {string[]} args
 * @returns {string[]}
 */
function redactCommand(args) {
  return args.map(redactArgument);
}

/**
 * @param {string} baseUrl
 * @returns {{key: string, target: string}[]}
 */
function gitRewriteRules(baseUrl) {
  return getPlatformManifest()
    .platforms.filter(platform => platform.category === 'code')
    .map(platform => ({
      key: platform.key,
      target: `${baseUrl}${platform.pathPrefix}`
    }));
}

/**
 * @param {string[]} command
 * @param {string} baseUrl
 * @returns {{command: string[], env: Record<string, string>, config: object[]}}
 */
function planGit(command, baseUrl) {
  const [executable] = command;
  const config = gitRewriteRules(baseUrl).map(rule => {
    const platform = getPlatformManifest().platforms.find(item => item.key === rule.key);
    return {
      key: `url.${rule.target}.insteadOf`,
      value: platform?.upstream || ''
    };
  });
  const commandWithConfig = [executable];
  for (const item of config) {
    commandWithConfig.push('-c', `${item.key}=${item.value}`);
  }
  commandWithConfig.push(...command.slice(1));
  return { command: commandWithConfig, env: {}, config };
}

/**
 * @param {string[]} command
 * @param {string} baseUrl
 * @returns {{command: string[], env: Record<string, string>, config: object[]}}
 */
function planNpm(command, baseUrl) {
  return {
    command,
    env: { npm_config_registry: `${baseUrl}/npm/` },
    config: [{ key: 'npm_config_registry', value: `${baseUrl}/npm/` }]
  };
}

/**
 * @param {string[]} command
 * @param {string} baseUrl
 * @returns {{command: string[], env: Record<string, string>, config: object[]}}
 */
function planPip(command, baseUrl) {
  return {
    command,
    env: { PIP_INDEX_URL: `${baseUrl}/pypi/simple` },
    config: [{ key: 'PIP_INDEX_URL', value: `${baseUrl}/pypi/simple` }]
  };
}

/**
 * Creates a child-process plan. It never edits persistent files or mutates process.env.
 * @param {string} adapter
 * @param {string} baseUrl
 * @param {string[]} command
 * @returns {ExecutionPlan & {config: object[]}}
 */
export function createExecutionPlan(adapter, baseUrl, command) {
  assertAdapter(adapter);
  if (!command.length || !command[0]) {
    throw new ContractError('MISSING_COMMAND', 'Provide a command after --.', 2);
  }
  const normalizedBase = validateBaseUrl(baseUrl);
  const planner = adapter === 'git' ? planGit : adapter === 'npm' ? planNpm : planPip;
  const planned = planner(command, normalizedBase);
  return {
    adapter,
    baseUrl: normalizedBase,
    command: planned.command,
    displayCommand: redactCommand(planned.command),
    env: planned.env,
    config: planned.config
  };
}

/**
 * @param {string[]} command
 * @param {Record<string, string | undefined>} env
 * @returns {Promise<{exitCode: number, signal: string | null, stdout: string, stderr: string}>}
 */
export function runChild(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {
      env,
      shell: false,
      stdio: ['inherit', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', () => {
      reject(
        new ContractError('COMMAND_NOT_FOUND', 'The requested native command was not found.', 3)
      );
    });
    child.on('close', (exitCode, signal) => {
      resolve({ exitCode: exitCode ?? 1, signal, stdout, stderr });
    });
  });
}

/**
 * @param {string} executable
 * @param {string[]} args
 * @param {Record<string, string | undefined>} env
 * @returns {{available: boolean, exitCode: number | null, output: string}}
 */
function checkExecutable(executable, args, env) {
  const result = spawnSync(executable, args, {
    env,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (result.error) {
    const { code } = /** @type {{code?: string}} */ (result.error);
    return { available: false, exitCode: null, output: code || 'not found' };
  }
  return {
    available: result.status === 0,
    exitCode: result.status,
    output: `${result.stdout || ''}${result.stderr || ''}`.trim()
  };
}

/**
 * Performs local adapter checks. Network probing is handled by the caller.
 * @param {string} adapter
 * @param {string} baseUrl
 * @param {Record<string, string | undefined>} env
 * @returns {AdapterInspection} Local adapter inspection.
 */
export function inspectAdapter(adapter, baseUrl, env) {
  assertAdapter(adapter);
  /** @type {[string, string[]][]} */
  const candidates =
    adapter === 'git'
      ? [['git', ['--version']]]
      : adapter === 'npm'
        ? [['npm', ['--version']]]
        : [
            ['python', ['-m', 'pip', '--version']],
            ['python3', ['-m', 'pip', '--version']]
          ];
  const [[firstExecutable, firstArgs], secondCandidate] = candidates;
  let executable = firstExecutable;
  let args = firstArgs;
  let tool = checkExecutable(executable, args, env);
  if (!tool.available && secondCandidate) {
    [executable, args] = secondCandidate;
    tool = checkExecutable(executable, args, env);
  }
  const plan = createExecutionPlan(adapter, baseUrl, [executable, ...args]);
  return {
    adapter,
    baseUrl: plan.baseUrl,
    config: plan.config,
    executable,
    tool,
    supported: true,
    network: { checked: false, ok: null }
  };
}

/**
 * Probes the instance manifest without following redirects to HTML.
 * @param {string} baseUrl
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{checked: boolean, ok: boolean, status?: number, schemaVersion?: number, catalogVersion?: string, reason?: string | null}>} Probe result.
 */
export async function probeInstance(baseUrl, fetchImpl = fetch) {
  const response = await fetchImpl(`${trimBaseUrl(baseUrl)}/.well-known/xget.json`, {
    method: 'GET',
    redirect: 'manual'
  });
  const contentType = response.headers.get('content-type') || '';
  if (!response.ok || !contentType.includes('application/json')) {
    return { checked: true, ok: false, status: response.status, reason: 'manifest-unavailable' };
  }
  const manifest = await response.json();
  return {
    checked: true,
    ok: manifest.schemaVersion === 1,
    status: response.status,
    schemaVersion: manifest.schemaVersion,
    catalogVersion: manifest.catalogVersion,
    reason: manifest.schemaVersion === 1 ? null : 'schema-mismatch'
  };
}

export { redactCommand };
