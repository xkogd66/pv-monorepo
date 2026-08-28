// Configuration Service
// Manages runtime configuration using environment variables only

// Read from window.__ENV__ (injected by the container entrypoint at runtime),
// falling back to import.meta.env for local Vite development.
function readEnv() {
  const env = window.__ENV__ || {};
  return {
    apiUrl: env.API_URL || import.meta.env.VITE_API_URL || 'https://vault-api.ekskog.net',
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || import.meta.env.VITE_TURNSTILE_SITE_KEY || '',
  };
}

class ConfigService {
  constructor() {
    // apiUrl is the only key overridable from the Settings UI. Anything else
    // stays env-managed so a stale localStorage value can't clobber it.
    let persistedApiUrl = null;
    try {
      const raw = localStorage.getItem('pv_config');
      const parsed = raw ? JSON.parse(raw) : {};
      if (typeof parsed.apiUrl === 'string' && parsed.apiUrl.trim()) {
        persistedApiUrl = parsed.apiUrl;
      }
    } catch (e) {
      // ignore malformed persisted config
    }

    this.config = readEnv();
    if (persistedApiUrl) this.config.apiUrl = persistedApiUrl;
  }

  // Get entire config
  getConfig() {
    return { ...this.config }
  }

  // Get specific config value
  get(key) {
    return this.config[key]
  }

  // Get API URL
  getApiUrl() {
    return this.config.apiUrl
  }

  // Persist runtime config to localStorage (dev-only)
  saveConfig(changes = {}) {
    try {
      this.config = { ...this.config, ...changes };
      const persisted = {
        apiUrl: this.config.apiUrl,
      };
      localStorage.setItem('pv_config', JSON.stringify(persisted));
      return true;
    } catch (e) {
      console.warn('Failed to persist config:', e.message);
      return false;
    }
  }

  // Reset persisted config to defaults (does not reload)
  reset() {
    try {
      localStorage.removeItem('pv_config');
      this.config = readEnv();
      return true;
    } catch (e) {
      console.warn('Failed to reset config:', e.message);
      return false;
    }
  }

  // Convenience accessor used in a few places in the SPA
  getToken() {
    return localStorage.getItem('hbvu_auth_token');
  }

  // Test API connection
  async testApiConnection(url = null) {
    const testUrl = url || this.getApiUrl()

    try {
      const response = await fetch(`${testUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000),
      })

      return {
        success: response.ok,
        status: response.status,
        url: testUrl
      }
    } catch (error) {
      return {
        success: false,
        error: error.message,
        url: testUrl
      }
    }
  }
}

// Export singleton instance
const configService = new ConfigService()
export default configService
