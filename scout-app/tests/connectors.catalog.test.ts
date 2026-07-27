import { describe, expect, it } from "vitest";
import { CONNECTOR_CATALOG, catalogConnector } from "../src/lib/connectorCatalog";

describe("curated MCP connector catalog", () => {
  it("contains 10 unique remote Streamable HTTP endpoints", () => {
    expect(CONNECTOR_CATALOG).toHaveLength(10);
    expect(new Set(CONNECTOR_CATALOG.map((connector) => connector.id)).size).toBe(10);
    expect(new Set(CONNECTOR_CATALOG.map((connector) => connector.url)).size).toBe(10);
    for (const connector of CONNECTOR_CATALOG) {
      expect(new URL(connector.url).protocol).toBe("https:");
    }
  });

  it("pins the work surfaces Scout needs for daily sweeps", () => {
    const names = CONNECTOR_CATALOG.filter((connector) => connector.featured).map((connector) => connector.name);
    expect(names).toEqual(expect.arrayContaining([
      "Gmail",
      "Google Calendar",
      "Slack",
      "Notion",
      "Jira & Confluence",
    ]));
  });

  it("marks providers that require a pre-registered OAuth client", () => {
    for (const id of ["gmail", "google-calendar", "google-drive", "slack", "hubspot"]) {
      expect(catalogConnector(id)?.authType).toBe("oauth_credentials");
      expect(catalogConnector(id)?.requiresClientSecret).toBe(true);
    }
  });

  it("uses direct browser OAuth where the provider supports a generic client", () => {
    for (const id of ["notion", "atlassian"]) {
      expect(catalogConnector(id)?.authType).toBe("oauth");
    }
  });

  it("does not present restricted hosted clients as immediately available", () => {
    for (const id of ["figma", "canva"]) {
      const connector = catalogConnector(id);
      expect(connector?.preview).toBe(true);
      expect(connector?.authType).toBe("oauth");
      expect(connector?.setupUrl).toMatch(/^https:\/\//);
      expect(connector?.setupNote).toBeTruthy();
    }
  });

  it("omits providers that are not part of Scout's connector library", () => {
    for (const id of ["asana", "stripe", "intercom", "linear"]) {
      expect(catalogConnector(id)).toBeUndefined();
    }
  });

  it("uses GitHub's supported PAT fallback instead of attempting DCR", () => {
    expect(catalogConnector("github")?.authType).toBe("bearer");
    expect(catalogConnector("github")?.authOptions).toEqual(["bearer", "oauth_credentials"]);
    expect(catalogConnector("github")?.requiresClientSecret).toBe(true);
  });
});
