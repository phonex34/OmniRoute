import MediaPageClient from "./MediaPageClient";
import { IMAGE_PROVIDERS } from "@omniroute/open-sse/config/imageRegistryData.ts";
import { toProviderModels } from "./mediaProviderModels";
import type { MediaProviderRegistry } from "./mediaProviderConnection";

/** Only the credential fields the connection check reads cross into the client bundle. */
function toImageProviderRegistry(): MediaProviderRegistry {
  return Object.fromEntries(
    Object.entries(IMAGE_PROVIDERS).map(([providerId, config]) => [
      providerId,
      { authType: config.authType, models: config.models.map((model) => ({ id: model.id })) },
    ])
  );
}

export default function MediaPage() {
  return (
    <MediaPageClient
      imageProviderModels={toProviderModels(IMAGE_PROVIDERS)}
      imageProviderRegistry={toImageProviderRegistry()}
    />
  );
}
