# Xget CLI

An offline CLI for inspecting Xget's bundled platform contract and converting
upstream URLs. Requires Node.js 22 or newer and has no runtime dependencies.

This release provides URL conversion, platform discovery, native command
execution, and local/instance diagnostics for Git, npm, and pip. Execution is
process-scoped and does not modify persistent configuration.

## Build and run from the Xget checkout

```bash
npm run build:cli
node packages/cli/bin/xget.js capabilities
node packages/cli/bin/xget.js resolve https://github.com/microsoft/vscode --base-url https://xget.example.com
```

All commands work without network access. The placeholder instance above is for
examples; supply your own instance to produce usable URLs. Only root HTTP(S)
instance URLs are supported. `--base-url` takes precedence over `XGET_BASE_URL`.

To build a standalone npm tarball from the Xget checkout:

```bash
npm run pack:cli
npm install --global ./xixu-me-xget-cli-0.2.0.tgz
xget version
```

The tarball includes the platform contract and conversion implementation; the
installed package needs neither the Xget checkout nor repository build scripts.
Packaging locally does not publish the package to a registry.

## Commands

| Command                 | Behavior                                                      |
| ----------------------- | ------------------------------------------------------------- |
| `capabilities`          | List the bundled platform descriptors and contract versions.  |
| `resolve <URL>`         | Convert an upstream URL using the bundled contract.           |
| `exec --adapter ... --` | Run Git, npm, or pip with temporary Xget settings.            |
| `doctor --adapter ...`  | Check a local tool; add `--probe` to inspect instance health. |
| `version` / `--version` | Report CLI, release, catalog, and schema versions.            |
| `help` / `--help`       | Show usage.                                                   |

`platforms` aliases `capabilities`. `convert --url <URL>` aliases
`resolve <URL>`. These aliases retain the old command spelling, but use the new
versioned JSON envelope. `topics`, `snippet`, `--source-url`, and `--readme-url`
are no longer supported. Human documentation is not an executable contract.

JSON is the default, and `--json` is shorthand for `--format json`.
`--format text` prints the converted URL or version, or a tab-separated platform
list. `capabilities --format table` adds column headings. Help prints text
unless JSON is explicitly requested.

```json
{
  "schemaVersion": 1,
  "cliVersion": "0.2.0",
  "catalogVersion": "1.0.0",
  "ok": false,
  "error": {
    "code": "MISSING_BASE_URL",
    "message": "Supply --base-url or set XGET_BASE_URL to your Xget instance root URL."
  }
}
```

Successful JSON responses have `ok: true` and `data` instead of `error`.
`capabilities` and `resolve` data include `source: "bundled"`; they do not claim
to describe a running instance. Errors go to stdout in JSON mode and stderr in
text mode. Exit codes are 0 for success, 2 for invalid arguments or input, 3 for
unsupported resources/conversions or failed doctor checks, and 1 for unexpected
internal errors. A failed child command returns its exit code and a
`CHILD_PROCESS_FAILED` error in JSON mode.

## Native command execution

`exec` requires an adapter, a base URL, and a command after `--`:

```bash
xget exec --adapter git --base-url https://xget.example -- git clone https://github.com/org/repo
xget exec --adapter npm --base-url https://xget.example -- npm ci
xget exec --adapter pip --base-url https://xget.example -- python -m pip install requests
```

The Git adapter adds command-level `-c url.*.insteadOf` rules for supported code
hosts. npm receives `npm_config_registry=<base>/npm/`; pip receives
`PIP_INDEX_URL=<base>/pypi/simple`. Existing child environment and command-line
options are preserved, and no files are edited. Commands are spawned without a
shell, so arguments are not interpolated. JSON mode captures child output under
`data.stdout` and `data.stderr`; text mode forwards those streams.

## Diagnostics

`doctor` checks the requested native executable and generated adapter
configuration without contacting the network:

```bash
xget doctor --adapter git --base-url https://xget.example --json
xget doctor --adapter npm --base-url https://xget.example --json
xget doctor --adapter pip --base-url https://xget.example --probe --json
```

`--probe` explicitly requests `/.well-known/xget.json` and verifies a JSON
schema-1 response. A probe never follows a redirect to the project homepage. The
returned `data` distinguishes local tool checks from the network check.

Conversion preserves query strings and fragments, including signed query
parameters. Treat successful output as sensitive when its input is sensitive.
Embedded username/password credentials are rejected, and error messages do not
echo input URLs. Conversion is limited to origins and paths in the bundled
catalog; an unsupported host is never guessed from a platform's brand name.

See the
[version contract](https://github.com/xixu-me/Xget/blob/main/docs/agent-contract.md)
in the source repository for compatibility rules and instance discovery.
