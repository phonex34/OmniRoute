import MediaPageClient from "./MediaPageClient";
import { IMAGE_PROVIDERS } from "@omniroute/open-sse/config/imageProviderData.ts";
import { toProviderModels } from "./mediaProviderModels";

export default function MediaPage() {
  return <MediaPageClient imageProviderModels={toProviderModels(IMAGE_PROVIDERS)} />;
}
