import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { after, test } from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const entry = path.join(repository, 'packages/cli/bin/xget.js');
const fixture = mkdtempSync(path.join(tmpdir(), 'xget-cli-test-'));
const preload = path.join(fixture, 'deny-network.mjs');
let invocation = 0;

// A successful fallback must not hide an attempted remote catalog lookup.
writeFileSync(
  preload,
  `import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
function deny() {
  appendFileSync(process.env.XGET_NETWORK_MARKER, 'network attempted\\n');
  throw new Error('Networking disabled by the CLI contract test');
}
globalThis.fetch = deny;
for (const transport of [http, https]) {
  transport.request = deny;
  transport.get = deny;
}
net.connect = deny;
net.createConnection = deny;
net.Socket.prototype.connect = deny;
tls.connect = deny;
dns.lookup = deny;
dns.resolve = deny;
syncBuiltinESMExports();
`
);

after(() => rmSync(fixture, { recursive: true, force: true }));

/**
 * Starts the real CLI in a separate process with networking disabled.
 * @param {string[]} args
 * @param {{cwd?: string, env?: Record<string, string>, entry?: string}} [options]
 */
function run(args, options = {}) {
  const marker = path.join(fixture, `network-${invocation++}`);
  const environment = { ...process.env };
  delete environment.XGET_BASE_URL;
  delete environment.NODE_OPTIONS;
  Object.assign(environment, options.env, { XGET_NETWORK_MARKER: marker });
  const result = spawnSync(
    process.execPath,
    ['--import', preload, options.entry || entry, ...args],
    {
      cwd: options.cwd || fixture,
      env: environment,
      encoding: 'utf8',
      timeout: 15000
    }
  );
  assert.equal(result.error, undefined, `CLI failed to start: ${result.error}`);
  assert.equal(result.signal, null, `CLI terminated: ${result.signal}`);
  assert.equal(existsSync(marker), false, 'CLI attempted network access');
  return result;
}

/**
 * Validates the process result and the single JSON response contract.
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @param {number} [status]
 */
function envelope(result, status = 0) {
  assert.equal(result.status, status, result.stderr || result.stdout);
  assert.equal(result.stderr, '', 'JSON mode must not mix diagnostics into stderr');
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.cliVersion, '0.2.0');
  assert.equal(output.catalogVersion, '1.0.0');
  assert.equal(output.ok, status === 0);
  return output;
}

/**
 * Asserts a stable, machine-readable failure and returns its raw output.
 * @param {string[]} args
 * @param {string} code
 * @param {number} [status]
 * @param {{cwd?: string, env?: Record<string, string>, entry?: string}} [options]
 */
function failure(args, code, status = 2, options = {}) {
  const result = run(args, options);
  const output = envelope(result, status);
  assert.equal(output.error.code, code);
  assert.equal(typeof output.error.message, 'string');
  assert.ok(output.error.message.length > 0);
  assert.equal(output.data, undefined);
  return result;
}

test('capabilities is a complete bundled catalog and requires no instance', () => {
  const { data } = envelope(run(['capabilities']));
  assert.equal(data.source, 'bundled');
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.catalogVersion, '1.0.0');
  assert.match(data.releaseVersion, /^\d+\.\d+\.\d+/);
  const { platforms } =
    /** @type {{platforms: {key: string, upstream: string, pathPrefix: string, category: string}[]}} */ (
      data
    );
  assert.ok(platforms.length > 50);
  assert.equal(new Set(platforms.map(platform => platform.key)).size, platforms.length);
  for (const platform of platforms) {
    assert.equal(typeof platform.key, 'string');
    assert.match(platform.upstream, /^https:\/\//);
    assert.match(platform.pathPrefix, /^\/.*\/$/);
    assert.equal(typeof platform.category, 'string');
  }
  const github = platforms.find(platform => platform.key === 'gh');
  assert.ok(github);
  assert.equal(github.upstream, 'https://github.com');
  assert.equal(github.pathPrefix, '/gh/');
});

test('platforms alias and explicit JSON output preserve the catalog', () => {
  const canonical = envelope(run(['capabilities']));
  assert.deepEqual(envelope(run(['platforms', '--json'])), canonical);
  assert.deepEqual(envelope(run(['capabilities', '--format', 'json'])), canonical);
});

test('version exposes compatible CLI, catalog, schema and release versions offline', () => {
  const output = envelope(run(['version']));
  assert.equal(output.data.cliVersion, output.cliVersion);
  assert.equal(output.data.schemaVersion, output.schemaVersion);
  assert.equal(output.data.catalogVersion, output.catalogVersion);
  assert.match(output.data.releaseVersion, /^\d+\.\d+\.\d+/);
  assert.deepEqual(envelope(run(['--version', '--json'])), output);
  const capabilities = envelope(run(['capabilities']));
  assert.equal(capabilities.data.releaseVersion, output.data.releaseVersion);
});

test('help works without an instance and supports the structured contract', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /capabilities/);
  assert.match(result.stdout, /resolve/);
  assert.equal(envelope(run(['help', '--json'])).ok, true);
});

const conversions = [
  {
    name: 'GitHub repository',
    upstream: 'https://github.com/example/project.git',
    platform: 'gh',
    converted: 'https://xget.example/gh/example/project.git'
  },
  {
    name: 'Hugging Face model with a download query',
    upstream: 'https://huggingface.co/org/model/resolve/main/weights.safetensors?download=true',
    platform: 'hf',
    converted: 'https://xget.example/hf/org/model/resolve/main/weights.safetensors?download=true'
  },
  {
    name: 'crates.io API download without a duplicated API prefix',
    upstream: 'https://crates.io/api/v1/crates/serde/1.0.0/download',
    platform: 'crates',
    converted: 'https://xget.example/crates/serde/1.0.0/download'
  },
  {
    name: 'OCI registry API',
    upstream: 'https://registry-1.docker.io/v2/library/alpine/manifests/latest',
    platform: 'cr-docker',
    converted: 'https://xget.example/cr/docker/v2/library/alpine/manifests/latest'
  },
  {
    name: 'longest upstream path match for Homebrew',
    upstream: 'https://github.com/Homebrew/brew/archive/refs/heads/master.tar.gz',
    platform: 'homebrew',
    converted: 'https://xget.example/homebrew/brew/archive/refs/heads/master.tar.gz'
  }
];

for (const conversion of conversions) {
  test(`resolve converts ${conversion.name} offline from an unrelated working directory`, () => {
    const { data } = envelope(
      run(['resolve', conversion.upstream, '--base-url', 'https://xget.example/'])
    );
    assert.equal(data.source, 'bundled');
    assert.equal(data.platform.key, conversion.platform);
    assert.equal(data.upstreamUrl, conversion.upstream);
    assert.equal(data.convertedUrl, conversion.converted);
    assert.equal(data.baseUrl, 'https://xget.example');
  });
}

test('convert --url remains an alias for resolve', () => {
  const url = 'https://github.com/org/repo';
  const options = ['--base-url', 'https://xget.example'];
  assert.deepEqual(
    envelope(run(['convert', '--url', url, ...options])),
    envelope(run(['resolve', url, ...options]))
  );
});

test('successful conversion preserves signed queries and fragments verbatim', () => {
  const suffix = '?token=download-secret&X-Amz-Signature=a%2Fb%2Bc&part=1&part=2#L10';
  const upstream = `https://github.com/org/repo/releases/download/v1/archive.zip${suffix}`;
  const { data } = envelope(run(['resolve', upstream, '--base-url', 'https://xget.example']));
  assert.equal(data.upstreamUrl, upstream);
  assert.equal(
    data.convertedUrl,
    `https://xget.example/gh/org/repo/releases/download/v1/archive.zip${suffix}`
  );
});

test('explicit instance takes priority over XGET_BASE_URL', () => {
  const url = 'https://github.com/org/repo';
  const env = { XGET_BASE_URL: 'https://environment.example/' };
  assert.equal(
    envelope(run(['resolve', url], { env })).data.convertedUrl,
    'https://environment.example/gh/org/repo'
  );
  assert.equal(
    envelope(run(['resolve', url, '--base-url', 'https://argument.example'], { env })).data
      .convertedUrl,
    'https://argument.example/gh/org/repo'
  );
});

test('URL resolution requires an explicit instance and never silently selects a public service', () => {
  failure(['resolve', 'https://github.com/org/repo'], 'MISSING_BASE_URL');
});

test('invalid instance origins are rejected without echoing credentials', () => {
  for (const base of [
    'not a URL',
    'file:///tmp/xget',
    'https://xget.example/prefix',
    'https://xget.example/?token=base-secret',
    'https://xget.example/#base-secret',
    'https://user:base-secret@xget.example'
  ]) {
    const result = failure(
      ['resolve', 'https://github.com/org/repo', '--base-url', base],
      'INVALID_BASE_URL'
    );
    assert.doesNotMatch(result.stdout + result.stderr, /base-secret/);
  }
});

test('invalid or unsupported upstreams have stable errors without leaking credentials', () => {
  const options = ['--base-url', 'https://xget.example'];
  failure(['resolve', 'not a URL', ...options], 'INVALID_URL');
  failure(['resolve', 'file:///etc/passwd', ...options], 'INVALID_URL');
  failure(['resolve', 'https://unsupported.example/resource', ...options], 'UNSUPPORTED_URL', 3);
  const result = failure(
    ['resolve', 'https://user:upstream-secret@github.com/org/repo', ...options],
    'INVALID_URL'
  );
  assert.doesNotMatch(result.stdout + result.stderr, /upstream-secret/);
  const unsupported = failure(
    ['resolve', 'https://unsupported.example/resource?token=download-secret', ...options],
    'UNSUPPORTED_URL',
    3
  );
  assert.doesNotMatch(unsupported.stdout + unsupported.stderr, /download-secret/);
});

test('unsupported crates.io web paths do not become incorrect API URLs', () => {
  failure(
    ['resolve', 'https://crates.io/crates/serde', '--base-url', 'https://xget.example'],
    'UNSUPPORTED_CONVERSION',
    3
  );
});

test('argument parsing is strict and returns one machine-readable error', () => {
  /** @type {[string[], string][]} */
  const cases = [
    [['invented-command'], 'UNKNOWN_COMMAND'],
    [['capabilities', '--invented-option'], 'UNKNOWN_OPTION'],
    [['resolve'], 'INVALID_ARGUMENT'],
    [['resolve', '--url'], 'INVALID_ARGUMENT'],
    [['capabilities', '--format'], 'INVALID_ARGUMENT'],
    [['capabilities', '--format', 'yaml'], 'INVALID_ARGUMENT'],
    [['capabilities', 'unexpected'], 'INVALID_ARGUMENT'],
    [
      [
        'resolve',
        'https://github.com/org/repo',
        'unexpected',
        '--base-url',
        'https://xget.example'
      ],
      'INVALID_ARGUMENT'
    ],
    [
      [
        'resolve',
        'https://github.com/org/repo',
        '--base-url',
        'https://xget.example',
        '--format',
        'table'
      ],
      'INVALID_ARGUMENT'
    ]
  ];
  for (const [args, code] of cases) {
    failure(args, code);
  }
});

test('text and table modes are usable without JSON wrappers', () => {
  const result = run([
    'resolve',
    'https://github.com/org/repo',
    '--base-url',
    'https://xget.example',
    '--format',
    'text'
  ]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /https:\/\/xget\.example\/gh\/org\/repo/);
  const table = run(['capabilities', '--format', 'table']);
  assert.equal(table.status, 0);
  assert.equal(table.stderr, '');
  assert.match(table.stdout, /github\.com/);
  assert.match(table.stdout, /\/gh\//);
  const error = run(['resolve', '--format', 'text']);
  assert.equal(error.status, 2);
  assert.equal(error.stdout, '');
  assert.match(error.stderr, /INVALID_ARGUMENT/);
});

test('URL arguments are passed literally without shell expansion', () => {
  const sentinel = path.join(fixture, 'shell-expanded');
  const queryValue = `$(touch\${IFS}${sentinel})`;
  const upstream = `https://github.com/org/repo?name=${queryValue}`;
  const { data } = envelope(run(['resolve', upstream, '--base-url', 'https://xget.example']));
  assert.equal(existsSync(sentinel), false);
  const query = new URL(data.convertedUrl).searchParams.get('name');
  assert.equal(query, queryValue);
});

test('npm tarball installs and executes independently of the source checkout', () => {
  const npmCache = path.join(fixture, 'npm-cache');
  const npmEnvironment = { ...process.env, npm_config_cache: npmCache };
  const packed = spawnSync(
    'npm',
    ['pack', '--ignore-scripts', '--offline', '--json', '--pack-destination', fixture],
    {
      cwd: path.join(repository, 'packages/cli'),
      env: npmEnvironment,
      encoding: 'utf8',
      timeout: 30000
    }
  );
  assert.equal(packed.error, undefined);
  assert.equal(packed.status, 0, packed.stderr);
  const [metadata] = JSON.parse(packed.stdout);
  const installed = path.join(fixture, 'installed');
  const install = spawnSync(
    'npm',
    [
      'install',
      '--offline',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--prefix',
      installed,
      path.join(fixture, metadata.filename)
    ],
    { cwd: fixture, env: npmEnvironment, encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(install.error, undefined);
  assert.equal(install.status, 0, install.stderr);
  const packageRoot = path.join(installed, 'node_modules/@xixu-me/xget-cli');
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '0.2.0');
  const installedEntry = path.join(packageRoot, manifest.bin.xget);
  const output = envelope(
    run(['resolve', 'https://github.com/org/repo', '--base-url', 'https://isolated.example'], {
      entry: installedEntry,
      cwd: installed
    })
  );
  assert.equal(output.data.convertedUrl, 'https://isolated.example/gh/org/repo');
});

test('generated Skill runs the same offline contract from any project directory', () => {
  const skillRoot = path.join(fixture, 'skill with spaces');
  mkdirSync(skillRoot);
  const skillInstructions = '---\nname: xget\n---\nKeep these authored instructions.\n';
  writeFileSync(path.join(skillRoot, 'SKILL.md'), skillInstructions);
  const synced = spawnSync(
    process.execPath,
    [path.join(repository, 'scripts/sync-xget-skill.mjs'), '--skill-dir', skillRoot],
    { cwd: fixture, encoding: 'utf8', timeout: 15000 }
  );
  assert.equal(synced.error, undefined);
  assert.equal(synced.status, 0, synced.stderr);
  assert.equal(readFileSync(path.join(skillRoot, 'SKILL.md'), 'utf8'), skillInstructions);
  const wrapper = path.join(skillRoot, 'scripts/xget.mjs');
  const snapshot = path.join(skillRoot, 'scripts/xget-cli');
  const packageJson = JSON.parse(readFileSync(path.join(snapshot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts, undefined, 'Skill must not depend on repository build scripts');
  assert.equal(existsSync(path.join(snapshot, 'LICENSE')), true);
  const provenance = JSON.parse(readFileSync(path.join(snapshot, 'provenance.json'), 'utf8'));
  assert.equal(provenance.cliVersion, '0.2.0');
  assert.equal(provenance.schemaVersion, 1);
  assert.deepEqual(
    envelope(run(['capabilities'], { entry: wrapper })),
    envelope(run(['capabilities']))
  );
  const args = [
    'resolve',
    'https://crates.io/api/v1/crates/serde/1.0.0/download',
    '--base-url',
    'https://isolated.example'
  ];
  assert.deepEqual(envelope(run(args, { entry: wrapper })), envelope(run(args)));
});

test('Skill sync refuses a different skill without overwriting its scripts', () => {
  const skillRoot = path.join(fixture, 'different-skill');
  mkdirSync(path.join(skillRoot, 'scripts'), { recursive: true });
  writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: another-skill\n---\n');
  const sentinel = path.join(skillRoot, 'scripts/xget.mjs');
  writeFileSync(sentinel, 'preserve this file');
  const synced = spawnSync(
    process.execPath,
    [path.join(repository, 'scripts/sync-xget-skill.mjs'), '--skill-dir', skillRoot],
    { cwd: fixture, encoding: 'utf8', timeout: 15000 }
  );
  assert.notEqual(synced.status, 0);
  assert.equal(readFileSync(sentinel, 'utf8'), 'preserve this file');
});

/**
 * Creates a portable fake executable for child-process tests.
 * @param {string} name
 * @returns {string} Fake executable path.
 */
function createFakeTool(name) {
  const tool = path.join(fixture, name);
  writeFileSync(
    tool,
    `#!/usr/bin/env node
const fs = await import('node:fs');
const payload = { argv: process.argv.slice(2), env: { npm_config_registry: process.env.npm_config_registry, PIP_INDEX_URL: process.env.PIP_INDEX_URL } };
process.stdout.write(JSON.stringify(payload));
process.exit(Number(process.env.XGET_FAKE_EXIT || 0));
`
  );
  chmodSync(tool, 0o755);
  return tool;
}

test('exec runs Git through command-level URL rewrites without a shell', () => {
  createFakeTool('git');
  const result = run(
    [
      'exec',
      '--adapter',
      'git',
      '--base-url',
      'https://xget.example',
      '--',
      'git',
      'clone',
      'https://github.com/org/repo',
      '$(touch-shell-sentinel)'
    ],
    { env: { PATH: `${fixture}:${process.env.PATH}` } }
  );
  const { data } = envelope(result);
  assert.equal(data.exitCode, 0);
  assert.equal(data.command[0], 'git');
  assert.ok(data.command.includes('-c'));
  assert.match(data.command.join(' '), /url\.https:\/\/xget\.example\/gh\//);
  const child = JSON.parse(data.stdout);
  assert.deepEqual(child.argv.slice(-3), [
    'clone',
    'https://github.com/org/repo',
    '$(touch-shell-sentinel)'
  ]);
  assert.equal(existsSync(path.join(fixture, 'touch-shell-sentinel')), false);
});

test('exec injects npm and pip settings only into the child process', () => {
  createFakeTool('npm');
  const npmResult = envelope(
    run(['exec', '--adapter', 'npm', '--base-url', 'https://xget.example', '--', 'npm', 'ci'], {
      env: { PATH: `${fixture}:${process.env.PATH}` }
    })
  );
  assert.equal(
    JSON.parse(npmResult.data.stdout).env.npm_config_registry,
    'https://xget.example/npm/'
  );
  assert.equal(process.env.npm_config_registry, undefined);

  createFakeTool('python');
  const pipResult = envelope(
    run(
      [
        'exec',
        '--adapter',
        'pip',
        '--base-url',
        'https://xget.example',
        '--',
        'python',
        '-m',
        'pip',
        'install',
        'requests'
      ],
      { env: { PATH: `${fixture}:${process.env.PATH}` } }
    )
  );
  assert.equal(
    JSON.parse(pipResult.data.stdout).env.PIP_INDEX_URL,
    'https://xget.example/pypi/simple'
  );
});

test('exec exposes child failures with a structured error and exit code', () => {
  createFakeTool('npm');
  const result = run(
    ['exec', '--adapter', 'npm', '--base-url', 'https://xget.example', '--', 'npm', '--version'],
    { env: { PATH: `${fixture}:${process.env.PATH}`, XGET_FAKE_EXIT: '7' } }
  );
  const output = envelope(result, 7);
  assert.equal(output.error.code, 'CHILD_PROCESS_FAILED');
  assert.equal(output.data.exitCode, 7);
});

test('doctor reports local adapter configuration without probing by default', () => {
  createFakeTool('git');
  const { data } = envelope(
    run(['doctor', '--adapter', 'git', '--base-url', 'https://xget.example'])
  );
  assert.equal(data.adapter, 'git');
  assert.equal(data.tool.available, true);
  assert.equal(data.network.checked, false);
  assert.equal(data.config[0].key.startsWith('url.https://xget.example/'), true);
});

test('exec and doctor validate adapter names and instance roots before running tools', () => {
  failure(
    ['exec', '--adapter', 'cargo', '--base-url', 'https://xget.example', '--', 'cargo', 'fetch'],
    'UNSUPPORTED_ADAPTER'
  );
  failure(
    ['doctor', '--adapter', 'npm', '--base-url', 'https://xget.example/prefix'],
    'INVALID_BASE_URL'
  );
  failure(
    [
      'exec',
      '--adapter',
      'npm',
      '--base-url',
      'https://xget.example',
      '--',
      'command-not-found-xget'
    ],
    'COMMAND_NOT_FOUND',
    3
  );
});
