# Xget agent contract

Xget's Worker, offline CLI, and distributed Skill share a platform description
and conversion implementation. The source lives in `src/config/` and
`src/contracts/`; CLI builds copy those modules without parsing remote source or
README headings. The Skill contains a generated, runnable snapshot of the same
CLI, so installation does not require downloading executable code at task time.

## Versions and compatibility

The current release uses:

| Field            | Current value | Meaning                                              |
| ---------------- | ------------- | ---------------------------------------------------- |
| `schemaVersion`  | `1`           | Shape and semantics of the machine contract.         |
| `catalogVersion` | `1.0.0`       | Version of platform and URL conversion rules.        |
| `releaseVersion` | `0.2.0`       | Xget contract release included in the Worker.        |
| `cliVersion`     | `0.2.0`       | CLI distribution version, aligned with this release. |

Within schema 1, consumers must tolerate additional fields and unknown platform
entries, and select fields by name rather than position. Removing or changing
the meaning/type of an existing field requires a new schema version. New
platforms require a catalog minor release; compatible fixes require a patch;
removing a platform or changing established routing/conversion semantics
requires a catalog major release. Update versions explicitly when changing that
contract.

CLI 0.2.x understands schema 1. The bundled catalog describes the CLI build, not
the current state of the internet or a deployed instance. Matching schema
versions establish parse compatibility; matching catalog versions establish the
same published rule set. Neither implies upstream availability or successful
authentication. An old instance without discovery can still accept established
proxy paths, but its exact capabilities remain unverified.

## Platform descriptions and instance discovery

`GET /.well-known/xget.json` returns the running Worker's manifest. `HEAD`
returns the same status and headers without a body. Other methods return a
structured 405. Discovery is handled locally and does not fetch upstream
resources.

The manifest includes versions, platform descriptors, and the narrowly declared
`routing` and `url-conversion` capabilities. Each descriptor identifies its key,
upstream base, canonical path prefix, category, and conversion metadata.
Transport permission is not a claim that Git push, OCI push, every provider API,
or arbitrary SDK behavior has been validated. Deployment gateways may require
authentication before allowing discovery.

CLI `capabilities` returns its **bundled** manifest and does not call this
endpoint. `doctor --probe` is the explicit instance-query path; it rejects
redirected HTML and reports schema mismatch separately from local tool failure.

## Offline conversion

`xget resolve <URL> --base-url <INSTANCE>` uses exact origin/path matching and
the longest applicable upstream path. Query strings and fragments are preserved.
Paths that cannot be represented faithfully through current routing are rejected
with `UNSUPPORTED_CONVERSION` instead of silently targeting another resource.

Instances must be root HTTP(S) URLs without credentials, query, fragment, or a
mount path. Local HTTP development instances are supported. No default public
instance is selected. The CLI makes no requests and does not verify that the
instance enables a route, credentials work, or the resource exists.

CLI JSON envelopes, exit codes, command aliases, and examples are described in
[the CLI guide](../packages/cli/README.md).

## Native adapters

`exec --adapter git|npm|pip -- COMMAND...` runs a native command with temporary
settings. Git receives command-level `url.*.insteadOf` rules for the code hosts
in the manifest; npm receives `npm_config_registry=<base>/npm/`; pip receives
`PIP_INDEX_URL=<base>/pypi/simple`. The CLI never edits persistent files and
spawns without a shell. `doctor` checks the corresponding executable and adapter
settings locally; `doctor --probe` additionally requests the instance manifest.
The child command's output and exit status remain observable in the JSON result.

## Updating and distributing the Skill

Edit the canonical sources, then run from the Xget checkout:

```bash
npm run build:cli
npm run test:cli
node scripts/sync-xget-skill.mjs --skill-dir /path/to/skills/skills/xget
```

The sync command only accepts an existing Skill named `xget`. It replaces the
generated `scripts/xget.mjs` wrapper and `scripts/xget-cli/` snapshot, including
license and version provenance. It preserves authored Skill instructions and
references. Update and validate those documents in the Skills repository as part
of the same change. Do not edit generated runtime files in the Skill.

The bundled wrapper resolves imports relative to itself and can run from any
project directory. Its generated package has no install-time build scripts or
runtime npm dependencies. Repeat the sync command after changing canonical
contract or CLI code so the distributed Skill uses the same implementation.
