import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProviderLogo } from "../src/components/ProviderLogo";
import { CONNECTOR_CATALOG } from "../src/lib/connectorCatalog";

describe("provider logos", () => {
  it("has a real provider mark for every curated connector", () => {
    for (const connector of CONNECTOR_CATALOG) {
      const markup = renderToStaticMarkup(createElement(ProviderLogo, {
        providerId: connector.id,
        fallback: connector.name,
      }));
      expect(markup, connector.name).not.toContain("provider-logo-fallback");
      expect(markup, connector.name).toContain("logo");
    }
  });
});
