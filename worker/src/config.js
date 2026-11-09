export const DEFAULT_ALLOWED_ORIGINS = 'https://*.aem.live,https://*.aem.page,https://*.preview.da.live,https://da.live,http://localhost:3000';

function jsonMap(env, name, errors) {
  const raw = env[name];
  if (!raw) return {};
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k.toLowerCase(), v]));
    }
  } catch {
    // fall through: report the variable name only, never its (secret) value
  }
  errors.push(`${name} is not a JSON object`);
  return {};
}

/** Reads Worker env (vars + secrets) into plain config. Invalid JSON fails closed to {}. */
export function loadConfig(env = {}) {
  const errors = [];
  const config = {
    allowedOrigins: (env.ALLOWED_ORIGINS || DEFAULT_ALLOWED_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean),
    siteKeys: jsonMap(env, 'SITE_KEYS', errors), // { "org/site": "<admin API key, role publish>" }
    siteProviders: jsonMap(env, 'SITE_PROVIDERS', errors), // { "org/site": "ziflow" }
    sitePolicies: jsonMap(env, 'SITE_POLICIES', errors), // { "org/site": { autoPublish, minorChangesAllowed } }
    defaultProvider: (env.PROOF_PROVIDER || 'sandbox').trim().toLowerCase(),
    errors,
  };
  config.providerFor = (site) => config.siteProviders[site] || config.defaultProvider;
  // TODO: per-site options from the DA config sheet `proof-seal` (seam §4); env for now.
  config.policyFor = (site) => ({
    autoPublish: true, minorChangesAllowed: false, ...config.sitePolicies[site],
  });
  return config;
}

export default loadConfig;
