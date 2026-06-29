// @vitest-environment jsdom
//
// #4606: the provider-topology card was extracted into HomeProviderTopologySection
// and its activity fetch gated behind widget visibility in HomePageClient
// (`appearanceSettingsLoaded && showProviderTopologyOnHome`). This guards the
// extracted section: it renders the topology card and feeds live active-requests
// through selectActiveRequests into ProviderTopology (Rule #18 for the change).
import React from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  // Values are echoed so the "{active} active · {errors} error" header count is observable.
  useTranslations: () => (key: string, values?: Record<string, unknown>) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
}));
vi.mock("next/dynamic", () => ({
  default: () => (props: Record<string, unknown>) => (
    <div
      data-testid="provider-topology"
      data-providers={String((props.providers as unknown[])?.length ?? 0)}
      data-active={String((props.activeRequests as unknown[])?.length ?? 0)}
    />
  ),
}));
vi.mock("@/shared/components", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
}));

// The live WS feed is stubbed so the merge with the poll-derived prop is deterministic.
const liveRequests: Array<{ provider: string; model: string }> = [];
vi.mock("@/hooks/useLiveDashboard", () => ({
  useLiveRequests: () => ({ activeRequests: liveRequests }),
}));

const { HomeProviderTopologySection } =
  await import("../../../src/app/(dashboard)/dashboard/HomeProviderTopologySection");

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  liveRequests.length = 0;
  vi.clearAllMocks();
});

it("renders the topology card and forwards providers to ProviderTopology", () => {
  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[
          { id: "p1", provider: "openai", name: "OpenAI" },
          { id: "p2", provider: "anthropic", name: "Anthropic" },
        ]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  expect(container.querySelector("[data-testid='card']")).not.toBeNull();
  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology).not.toBeNull();
  expect(topology?.getAttribute("data-providers")).toBe("2");
  expect(container.textContent).toContain("activeError");
  expect(container.textContent).toContain("topologyLegendActive");
  expect(container.textContent).toContain("topologyLegendRecent");
  expect(container.textContent).toContain("topologyLegendError");
});

it("forwards poll-derived active requests to ProviderTopology", () => {
  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[{ id: "p1", provider: "openai", name: "OpenAI" }]}
        activeRequests={[
          { provider: "openai", model: "" },
          { provider: "anthropic", model: "" },
        ]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology?.getAttribute("data-active")).toBe("2");
});

it("merges the live feed with poll-derived requests, deduped per provider", () => {
  liveRequests.push({ provider: "openai", model: "gpt-4o" });

  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[{ id: "p1", provider: "openai", name: "OpenAI" }]}
        activeRequests={[
          { provider: "openai", model: "" },
          { provider: "anthropic", model: "" },
        ]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  // openai comes from the socket (with its model), anthropic only from polling:
  // the poll-only duplicate for openai is dropped, so two entries reach the topology.
  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology?.getAttribute("data-active")).toBe("2");
  expect(container.textContent).toContain('activeError:{"active":2,"errors":0}');
});

// The WS payload is unnormalized while the polled ids ran through
// normalizeProviderId, so a case difference must not resurrect a duplicate node
// or double-count the provider in the "{active} active" header.
it("dedupes across feeds when the live provider id differs only by case", () => {
  liveRequests.push({ provider: "OpenAI", model: "gpt-4o" });

  act(() => {
    root.render(
      <HomeProviderTopologySection
        providers={[{ id: "p1", provider: "openai", name: "OpenAI" }]}
        activeRequests={[{ provider: "openai", model: "" }]}
        lastProvider="openai"
        errorProvider=""
      />
    );
  });

  const topology = container.querySelector("[data-testid='provider-topology']");
  expect(topology?.getAttribute("data-active")).toBe("1");
  expect(container.textContent).toContain('activeError:{"active":1,"errors":0}');
});
