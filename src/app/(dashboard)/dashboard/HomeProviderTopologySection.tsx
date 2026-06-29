"use client";

import { useTranslations } from "next-intl";
import dynamic from "next/dynamic";

import { Card } from "@/shared/components";

const ProviderTopology = dynamic(() => import("../home/ProviderTopology"), { ssr: false });

type TopologyProvider = {
  id: string;
  provider: string;
  name?: string;
};

type TopologyActiveRequest = {
  provider: string;
  model: string;
};

export function HomeProviderTopologySection({
  providers,
  activeRequests = [],
  lastProvider,
  errorProvider,
}: {
  providers: TopologyProvider[];
  activeRequests?: TopologyActiveRequest[];
  lastProvider: string;
  errorProvider: string;
  enabled?: boolean;
}) {
  const t = useTranslations("home");

  return (
    <Card>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-base font-semibold">{t("providerTopology")}</h2>
          <p className="text-xs text-text-muted">
            Connected providers routing through OmniRoute in real time
          </p>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-text-muted">
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-green-500" /> Active
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-amber-500" /> Recent
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-red-500" /> Error
          </span>
        </div>
      </div>
      <ProviderTopology
        providers={providers}
        activeRequests={activeRequests}
        lastProvider={lastProvider}
        errorProvider={errorProvider}
      />
    </Card>
  );
}
