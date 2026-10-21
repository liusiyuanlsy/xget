import {
  CATALOG_VERSION,
  ContractError,
  getPlatformManifest,
  RELEASE_VERSION,
  resolveUrl,
  SCHEMA_VERSION
} from '../shared/contracts/index.js';
import { createExecutionPlan, inspectAdapter, probeInstance, runChild } from './adapters.js';

export const CLI_VERSION = RELEASE_VERSION;

const HELP = `Usage: xget <command> [options]

Commands:
  capabilities              List the bundled platform and conversion contract.
  resolve <URL>             Convert an upstream HTTP(S) URL without network access.
  exec --adapter ADAPTER -- COMMAND [ARGS...]
                            Run a native Git, npm, or pip command with Xget.
  doctor --adapter ADAPTER  Check local tool/configuration; add --probe for the instance.
  version                   Show CLI and contract versions.
  help                      Show this help.

Options:
  --base-url URL            Root Xget instance URL; otherwise XGET_BASE_URL.
  --adapter git|npm|pip     Native tool adapter for exec and doctor.
  --probe                   Ask the instance for /.well-known/xget.json (doctor only).
  --format json|text|table   JSON by default; table is for capabilities only.
  --json                    Alias for --format json.
  --help                    Show help.
  --version                 Alias for version.

Compatibility aliases:
  platforms                 Alias for capabilities.
  convert --url URL         Alias for resolve <URL>.

All commands are non-persistent. exec only changes the child process environment
or command-level configuration; it never writes project or user config files.
`;

/**
 * @typedef {{command: string, positionals: string[], passthrough: string[], options: Record<string, string | boolean>}} Arguments
 */

/**
 * Parses strict CLI options and preserves child arguments after `--` verbatim.
 * @param {string[]} argv
 * @returns {Arguments} Validated options and command arguments.
 */
function parseArguments(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {};
  const positionals = [];
  const passthrough = [];
  const booleanOptions = new Set(['json', 'help', 'version', 'probe']);
  const valueOptions = new Set(['base-url', 'url', 'format', 'adapter']);
  let separatorSeen = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (separatorSeen) {
      passthrough.push(token);
      continue;
    }
    if (token === '--') {
      separatorSeen = true;
      continue;
    }
    if (!token.startsWith('-')) {
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--')) {
      throw new ContractError('UNKNOWN_OPTION', 'Unknown option. Use --help for options.', 2);
    }

    const separator = token.indexOf('=');
    const key = token.slice(2, separator === -1 ? undefined : separator);
    if (!booleanOptions.has(key) && !valueOptions.has(key)) {
      throw new ContractError('UNKNOWN_OPTION', 'Unknown option. Use --help for options.', 2);
    }
    if (Object.hasOwn(options, key)) {
      throw new ContractError('INVALID_ARGUMENT', 'Options must not be repeated.', 2);
    }
    if (booleanOptions.has(key)) {
      if (separator !== -1) {
        throw new ContractError('INVALID_ARGUMENT', 'Boolean options take no value.', 2);
      }
      options[key] = true;
      continue;
    }
    const value = separator === -1 ? argv[++index] : token.slice(separator + 1);
    if (!value || value.startsWith('--')) {
      throw new ContractError('INVALID_ARGUMENT', `Missing value for --${key}.`, 2);
    }
    options[key] = value;
  }

  if (options.json && options.format) {
    throw new ContractError('INVALID_ARGUMENT', 'Use --json or --format, not both.', 2);
  }
  const command = positionals.shift() || 'help';
  return { command, positionals, passthrough, options };
}

/**
 * Selects the output format used for parse failures.
 * @param {string[]} argv
 * @returns {string} Requested error output format.
 */
function errorFormat(argv) {
  if (argv.includes('--json')) return 'json';
  const inline = argv.find(token => token.startsWith('--format='));
  const index = argv.indexOf('--format');
  return (inline?.slice('--format='.length) || (index >= 0 ? argv[index + 1] : 'json')) === 'text'
    ? 'text'
    : 'json';
}

/**
 * Creates the versioned response envelope.
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>} Envelope.
 */
function envelope(result) {
  return {
    schemaVersion: SCHEMA_VERSION,
    cliVersion: CLI_VERSION,
    catalogVersion: CATALOG_VERSION,
    ...result
  };
}

/**
 * Runs the CLI. exec and doctor are asynchronous because they may run a child process or probe.
 * @param {string[]} argv
 * @param {{env?: Record<string, string | undefined>, stdout?: {write: (chunk: string) => unknown}, stderr?: {write: (chunk: string) => unknown}}} [context]
 * @returns {Promise<number>} Process exit code.
 */
export async function runCli(argv, context = {}) {
  const env = context.env ?? process.env;
  const stdout = context.stdout ?? process.stdout;
  const stderr = context.stderr ?? process.stderr;
  let format = errorFormat(argv);

  try {
    const { command: inputCommand, positionals, passthrough, options } = parseArguments(argv);
    format = typeof options.format === 'string' ? options.format : 'json';
    if (!['json', 'text', 'table'].includes(format)) {
      throw new ContractError('INVALID_ARGUMENT', 'Use --format json, text, or table.', 2);
    }
    const aliases = /** @type {Record<string, string>} */ ({
      platforms: 'capabilities',
      convert: 'resolve'
    });
    const command = options.help
      ? 'help'
      : options.version
        ? 'version'
        : (aliases[inputCommand] ?? inputCommand);
    if (!['help', 'version', 'capabilities', 'resolve', 'exec', 'doctor'].includes(command)) {
      throw new ContractError('UNKNOWN_COMMAND', 'Unknown command. Use --help for commands.', 2);
    }
    if (format === 'table' && command !== 'capabilities') {
      throw new ContractError('INVALID_ARGUMENT', 'Table output is for capabilities only.', 2);
    }
    if (!['resolve', 'exec', 'doctor'].includes(command) && (options.url || options['base-url'])) {
      throw new ContractError(
        'INVALID_ARGUMENT',
        'URL options are for resolve, exec, or doctor only.',
        2
      );
    }
    if (command === 'resolve' && positionals.length > 1) {
      throw new ContractError('INVALID_ARGUMENT', 'Resolve accepts one URL.', 2);
    }
    if (command !== 'resolve' && positionals.length > 0) {
      throw new ContractError('INVALID_ARGUMENT', 'Unexpected positional arguments.', 2);
    }
    if (command !== 'exec' && passthrough.length > 0) {
      throw new ContractError(
        'INVALID_ARGUMENT',
        'A command separator is supported only by exec.',
        2
      );
    }
    if (command !== 'doctor' && options.probe) {
      throw new ContractError('INVALID_ARGUMENT', 'Use --probe only with doctor.', 2);
    }

    if (command === 'help') {
      if (options.json || options.format === 'json') {
        stdout.write(`${JSON.stringify(envelope({ ok: true, data: { help: HELP } }), null, 2)}\n`);
      } else {
        stdout.write(HELP);
      }
      return 0;
    }

    /** @type {Record<string, unknown>} */
    let data;
    if (command === 'version') {
      data = {
        cliVersion: CLI_VERSION,
        schemaVersion: SCHEMA_VERSION,
        catalogVersion: CATALOG_VERSION,
        releaseVersion: RELEASE_VERSION
      };
    } else if (command === 'capabilities') {
      data = { source: 'bundled', ...getPlatformManifest() };
    } else if (command === 'resolve') {
      if (positionals.length && options.url) {
        throw new ContractError(
          'INVALID_ARGUMENT',
          'Supply a positional URL or --url, not both.',
          2
        );
      }
      const inputUrl = positionals[0] || options.url;
      if (typeof inputUrl !== 'string' || !inputUrl) {
        throw new ContractError('INVALID_ARGUMENT', 'A URL is required for resolve.', 2);
      }
      const baseUrl = options['base-url'] ?? env.XGET_BASE_URL;
      if (typeof baseUrl !== 'string' || !baseUrl) {
        throw new ContractError(
          'MISSING_BASE_URL',
          'Supply --base-url or set XGET_BASE_URL to your Xget instance root URL.',
          2
        );
      }
      data = { source: 'bundled', ...resolveUrl(inputUrl, baseUrl) };
    } else {
      const { adapter } = options;
      if (typeof adapter !== 'string' || !adapter) {
        throw new ContractError('MISSING_ADAPTER', 'Supply --adapter git, npm, or pip.', 2);
      }
      const baseUrl = options['base-url'] ?? env.XGET_BASE_URL;
      if (typeof baseUrl !== 'string' || !baseUrl) {
        throw new ContractError(
          'MISSING_BASE_URL',
          'Supply --base-url or set XGET_BASE_URL to your Xget instance root URL.',
          2
        );
      }
      if (command === 'exec') {
        const plan = createExecutionPlan(adapter, baseUrl, passthrough);
        const result = await runChild(plan.command, { ...env, ...plan.env });
        data = {
          adapter,
          baseUrl: plan.baseUrl,
          command: plan.displayCommand,
          exitCode: result.exitCode,
          signal: result.signal,
          stdout: result.stdout,
          stderr: result.stderr
        };
        if (format === 'text') {
          stdout.write(result.stdout);
          stderr.write(result.stderr);
          return result.exitCode;
        }
        if (result.exitCode !== 0 || result.signal) {
          stdout.write(
            `${JSON.stringify(envelope({ ok: false, data, error: { code: 'CHILD_PROCESS_FAILED', message: `The ${adapter} command exited unsuccessfully.` } }), null, 2)}\n`
          );
          return result.exitCode || 1;
        }
      } else {
        const inspection = inspectAdapter(adapter, baseUrl, env);
        data = inspection;
        if (options.probe) {
          try {
            inspection.network = await probeInstance(inspection.baseUrl);
          } catch {
            inspection.network = { checked: true, ok: false, reason: 'probe-failed' };
          }
        }
        const healthy = inspection.tool.available && (!options.probe || inspection.network.ok);
        if (!healthy) {
          if (format === 'text') {
            stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
          } else {
            stdout.write(
              `${JSON.stringify(envelope({ ok: false, data, error: { code: 'DOCTOR_FAILED', message: 'One or more doctor checks failed.' } }), null, 2)}\n`
            );
          }
          return 3;
        }
      }
    }

    if (format === 'json') {
      stdout.write(`${JSON.stringify(envelope({ ok: true, data }), null, 2)}\n`);
    } else if (command === 'capabilities') {
      const { platforms } = getPlatformManifest();
      if (format === 'table') stdout.write('key\tcategory\tpathPrefix\tupstream\n');
      for (const platform of platforms)
        stdout.write(
          `${platform.key}\t${platform.category}\t${platform.pathPrefix}\t${platform.upstream}\n`
        );
    } else if (command === 'resolve') {
      stdout.write(`${data.convertedUrl}\n`);
    } else {
      stdout.write(`${JSON.stringify(data, null, 2)}\n`);
    }
    return 0;
  } catch (error) {
    const failure =
      error instanceof ContractError
        ? error
        : new ContractError('INTERNAL_ERROR', 'An internal CLI error occurred.', 1);
    if (format === 'text') {
      stderr.write(`${failure.code}: ${failure.message}\n`);
    } else {
      stdout.write(
        `${JSON.stringify(envelope({ ok: false, error: { code: failure.code, message: failure.message } }), null, 2)}\n`
      );
    }
    return failure.exitCode;
  }
}
