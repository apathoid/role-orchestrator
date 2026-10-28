import { providerImplementations } from './capabilities.mjs';

/**
 * A stable synchronous descriptor for routing and capability previews, with
 * provider-specific code imported only when the selected provider is used.
 * This deliberately does not call prepare() for listModels(): callers retain
 * the existing provider's own model discovery semantics.
 */
export class LazyProvider {
  #instance = null;
  #loading = null;
  #closing = false;

  constructor(name, config, runtime = {}) {
    this.name = name;
    this.config = config;
    this.runtime = runtime;
    this.spec = providerImplementations[config.adapter ?? config.type];
    if (!this.spec) throw new Error(`Unsupported provider adapter: ${config.adapter ?? config.type}`);
  }

  capabilities() {
    return this.#instance?.capabilities?.() ?? this.spec.capabilities(this.config, this.runtime);
  }

  async #load() {
    if (this.#closing) throw new Error(`${this.name}: provider already closed`);
    if (this.#instance) return this.#instance;
    if (!this.#loading) {
      this.#loading = import(this.spec.module).then((module) => {
        const Provider = module[this.spec.exportName];
        if (typeof Provider !== 'function') throw new Error(`${this.name}: adapter module missing ${this.spec.exportName}`);
        this.#instance = new Provider(this.name, this.config, this.runtime);
        return this.#instance;
      }).finally(() => { this.#loading = null; });
    }
    return this.#loading;
  }

  async prepare() { const p = await this.#load(); await p.prepare?.(); }
  async invoke(request) { return (await this.#load()).invoke(request); }
  async listModels() { const p = await this.#load(); return p.listModels?.() ?? this.config.models ?? []; }
  async cancel(invocationId) { const p = this.#instance ?? (this.#loading ? await this.#loading : null); await p?.cancel?.(invocationId); }
  async close() {
    this.#closing = true;
    const p = this.#instance ?? (this.#loading ? await this.#loading : null);
    await p?.close?.();
  }
}
