import { PLATFORM_DEFINITIONS } from '../config/platform-catalog.js';
import { getPlatformPathPrefix, matchPlatformPath } from '../routing/platform-index.js';
import { transformPath } from '../routing/platform-transformers.js';
import { normalizeRegistryApiPath } from '../routing/registry-path.js';
import { ContractError } from './errors.js';
import { CATALOG_VERSION, RELEASE_VERSION, SCHEMA_VERSION } from './version.js';

/**
 * Public platform metadata, with no claim that upstream operations were verified.
 * @typedef {object} PlatformDescription
 * @property {string} key Stable platform identifier.
 * @property {string} upstream Canonical upstream base address.
 * @property {string} pathPrefix Platform prefix accepted by Xget routing.
 * @property {string} category Resource family used by clients for discovery.
 * @property {import('../config/platform-catalog.js').PlatformConversion} conversion Shared conversion rules.
 */

/**
 * Builds an independent description so callers cannot mutate the routing catalog.
 * @param {string} key
 * @returns {PlatformDescription} Independent serializable platform description.
 */
function describePlatform(key) {
  const definition = PLATFORM_DEFINITIONS[key];
  return {
    key,
    upstream: definition.upstream,
    pathPrefix: getPlatformPathPrefix(key),
    category: definition.category,
    conversion: {
      ...definition.conversion,
      ...(definition.conversion.normalizationAliases
        ? { normalizationAliases: [...definition.conversion.normalizationAliases] }
        : {})
    }
  };
}

/**
 * Describes bundled routing and conversion capabilities for all configured platforms.
 * @returns {{schemaVersion: number, catalogVersion: string, releaseVersion: string, capabilities: string[], platforms: PlatformDescription[]}} Versioned platform manifest.
 */
export function getPlatformManifest() {
  return {
    schemaVersion: SCHEMA_VERSION,
    catalogVersion: CATALOG_VERSION,
    releaseVersion: RELEASE_VERSION,
    capabilities: ['routing', 'url-conversion'],
    platforms: Object.keys(PLATFORM_DEFINITIONS).map(describePlatform)
  };
}

/**
 * Parses an absolute HTTP URL without silently accepting credentials or whitespace.
 * Error text deliberately omits the input, which may contain sensitive query values.
 * @param {string} value
 * @param {boolean} isBase
 * @returns {URL} Parsed and validated HTTP URL.
 */
function parseHttpUrl(value, isBase) {
  const code = isBase ? 'INVALID_BASE_URL' : 'INVALID_URL';
  const label = isBase ? 'Base URL' : 'Input URL';
  if (
    typeof value !== 'string' ||
    !/^https?:\/\//i.test(value) ||
    /[\s\\]/.test(value) ||
    [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    throw new ContractError(code, `${label} must be an absolute HTTP or HTTPS URL.`);
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ContractError(code, `${label} must be an absolute HTTP or HTTPS URL.`);
  }
  if (parsed.username || parsed.password || /^https?:\/\/[^/?#]*@/i.test(value)) {
    throw new ContractError(code, `${label} must not contain credentials.`);
  }
  if (isBase && (parsed.pathname !== '/' || /[?#]/.test(value))) {
    throw new ContractError(
      code,
      'Base URL must be an origin without a path prefix, query, or fragment.'
    );
  }
  return parsed;
}

/**
 * Tests a path against a complete upstream path prefix.
 * @param {string} path
 * @param {string} prefix
 * @returns {boolean} Whether the path is inside the prefix boundary.
 */
function matchesPathPrefix(path, prefix) {
  return !prefix || path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * Resolves an upstream URL offline using the same paths as Worker routing.
 * Conversion preserves the query and fragment. The optional normalization field
 * explicitly discloses canonicalization already performed by the Worker.
 * @param {string} inputUrl
 * @param {string} baseUrl
 * @returns {{platform: PlatformDescription, upstreamUrl: string, convertedUrl: string, baseUrl: string, normalization?: {code: string, inputUrl: string}}} Converted resource and canonical upstream information.
 * @throws {ContractError} For invalid, unsupported, or unrepresentable URLs.
 */
export function resolveUrl(inputUrl, baseUrl) {
  const input = parseHttpUrl(inputUrl, false);
  const base = parseHttpUrl(baseUrl, true);
  const originCandidates = Object.keys(PLATFORM_DEFINITIONS).filter(
    key => input.origin === new URL(PLATFORM_DEFINITIONS[key].upstream).origin
  );
  if (!originCandidates.length) {
    throw new ContractError('UNSUPPORTED_URL', 'No platform supports this URL origin.', 3);
  }
  const candidates = originCandidates
    .filter(key =>
      matchesPathPrefix(input.pathname, PLATFORM_DEFINITIONS[key].conversion.matchPathPrefix)
    )
    .sort(
      (a, b) =>
        PLATFORM_DEFINITIONS[b].conversion.matchPathPrefix.length -
        PLATFORM_DEFINITIONS[a].conversion.matchPathPrefix.length
    );
  if (!candidates.length) {
    throw new ContractError(
      'UNSUPPORTED_CONVERSION',
      'No platform route supports this upstream URL path.',
      3
    );
  }

  const platform = describePlatform(candidates[0]);
  const relativePath = input.pathname.slice(platform.conversion.stripPathPrefix.length);
  const convertedPath = `${platform.pathPrefix}${relativePath.replace(/^\//, '')}`;
  const isRoot = convertedPath === platform.pathPrefix;
  if (
    matchPlatformPath(convertedPath) !== platform.key ||
    (isRoot && !platform.conversion.rootRoute)
  ) {
    throw new ContractError(
      'UNSUPPORTED_CONVERSION',
      'This URL cannot be represented by a resource route on Xget.',
      3
    );
  }

  let upstreamPath = transformPath(convertedPath, platform.key);
  upstreamPath = normalizeRegistryApiPath(platform.key, upstreamPath);
  const actualUpstream = new URL(`${platform.upstream}${upstreamPath}${input.search}${input.hash}`);
  let normalization;
  if (actualUpstream.href !== input.href) {
    if (!platform.conversion.normalizationAliases?.includes(input.pathname)) {
      throw new ContractError(
        'UNSUPPORTED_CONVERSION',
        'This URL would be rewritten to a different upstream resource by Xget.',
        3
      );
    }
    normalization = { code: 'JENKINS_CURRENT_PATH', inputUrl: input.href };
  }

  return {
    platform,
    upstreamUrl: actualUpstream.href,
    convertedUrl: `${base.origin}${convertedPath}${input.search}${input.hash}`,
    baseUrl: base.origin,
    ...(normalization ? { normalization } : {})
  };
}

/**
 * Validates and normalizes an instance root for adapters and diagnostics.
 * @param {string} baseUrl
 * @returns {string} Origin-only instance URL.
 */
export function validateBaseUrl(baseUrl) {
  return parseHttpUrl(baseUrl, true).origin;
}
