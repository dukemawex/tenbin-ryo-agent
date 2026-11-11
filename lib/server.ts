import { RyoClient } from "./ryo";
import { getStore } from "./store";
import { freeModels } from "./llm";

export async function status() {
  const client = new RyoClient();
  const store = getStore();
  const health = await client.health();
  let quota: unknown = null;
  if (client.hasKey) quota = (await client.whoami()).quota;
  return {
    ryo: { endpoint: client.baseUrl, healthy: health.ok, health: health.body, http_status: health.http_status, error: health.error, credential_configured: client.hasKey, quota },
    model: { provider: "openrouter", configured: !!process.env.OPENROUTER_API_KEY, chain: freeModels() },
    store: store.kind,
    checked_at: new Date().toISOString(),
  };
}
