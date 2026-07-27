export type CatalogAuthType = "oauth" | "oauth_credentials" | "bearer";

export interface CatalogConnector {
  id: string;
  name: string;
  description: string;
  url: string;
  authType: CatalogAuthType;
  authOptions?: CatalogAuthType[];
  category: "Communication" | "Knowledge" | "Projects" | "Developer" | "Business";
  featured?: boolean;
  preview?: boolean;
  requiresClientSecret?: boolean;
  setupUrl?: string;
  setupNote?: string;
}

/**
 * Curated remote, Streamable HTTP MCP servers. Endpoints come from each
 * provider's first-party documentation; no local package installation is used.
 */
export const CONNECTOR_CATALOG: CatalogConnector[] = [
  {
    id: "gmail",
    name: "Gmail",
    description: "Search mail, read threads, create drafts, and manage labels.",
    url: "https://gmailmcp.googleapis.com/mcp/v1",
    authType: "oauth_credentials",
    category: "Communication",
    featured: true,
    preview: true,
    requiresClientSecret: true,
    setupUrl: "https://developers.google.com/workspace/gmail/api/guides/configure-mcp-server",
    setupNote: "Google requires your own Cloud OAuth client and enabled Gmail MCP API.",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    description: "Read schedules, find time, and prepare calendar changes.",
    url: "https://calendarmcp.googleapis.com/mcp/v1",
    authType: "oauth_credentials",
    category: "Communication",
    featured: true,
    preview: true,
    requiresClientSecret: true,
    setupUrl: "https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server",
    setupNote: "Google requires your own Cloud OAuth client and enabled Calendar MCP API.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    description: "Find and read files across shared drives and My Drive.",
    url: "https://drivemcp.googleapis.com/mcp/v1",
    authType: "oauth_credentials",
    category: "Knowledge",
    preview: true,
    requiresClientSecret: true,
    setupUrl: "https://developers.google.com/workspace/drive/api/guides/configure-mcp-server",
    setupNote: "Google requires your own Cloud OAuth client and enabled Drive MCP API.",
  },
  {
    id: "slack",
    name: "Slack",
    description: "Search conversations, read threads, and draft team updates.",
    url: "https://mcp.slack.com/mcp",
    authType: "oauth_credentials",
    category: "Communication",
    featured: true,
    requiresClientSecret: true,
    setupUrl: "https://docs.slack.dev/ai/slack-mcp-server/",
    setupNote: "Slack requires a Marketplace or internal app with MCP enabled.",
  },
  {
    id: "notion",
    name: "Notion",
    description: "Search workspace knowledge and create or update pages.",
    url: "https://mcp.notion.com/mcp",
    authType: "oauth",
    category: "Knowledge",
    featured: true,
  },
  {
    id: "atlassian",
    name: "Jira & Confluence",
    description: "Track work in Jira and search or update Confluence.",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    authType: "oauth",
    category: "Projects",
    featured: true,
  },
  {
    id: "github",
    name: "GitHub",
    description: "Review repositories, issues, pull requests, and workflows.",
    url: "https://api.githubcopilot.com/mcp/",
    authType: "bearer",
    authOptions: ["bearer", "oauth_credentials"],
    requiresClientSecret: true,
    category: "Developer",
    setupUrl: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp-in-your-ide/set-up-the-github-mcp-server",
    setupNote: "GitHub does not dynamically register Scout. Use a PAT now, or select OAuth credentials after registering a Scout GitHub OAuth app.",
  },
  {
    id: "figma",
    name: "Figma",
    description: "Read design context, components, variables, and FigJam boards.",
    url: "https://mcp.figma.com/mcp",
    authType: "oauth",
    category: "Developer",
    preview: true,
    setupUrl: "https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/",
    setupNote: "Figma currently limits its remote MCP server to approved clients in the Figma MCP Catalog.",
  },
  {
    id: "canva",
    name: "Canva",
    description: "Find designs, create assets, and work with brand content.",
    url: "https://mcp.canva.com/mcp",
    authType: "oauth",
    category: "Business",
    preview: true,
    setupUrl: "https://www.canva.dev/docs/mcp/",
    setupNote: "Canva must allowlist Scout's redirect URI before this client can connect.",
  },
  {
    id: "hubspot",
    name: "HubSpot",
    description: "Work with CRM records, sales context, and customer activity.",
    url: "https://mcp.hubspot.com",
    authType: "oauth_credentials",
    requiresClientSecret: true,
    category: "Business",
    setupUrl: "https://developers.hubspot.com/docs/apps/developer-platform/build-apps/integrate-with-the-remote-hubspot-mcp-server",
    setupNote: "HubSpot requires a pre-registered MCP auth app with PKCE enabled.",
  },
];

export function catalogConnector(id: string | null): CatalogConnector | undefined {
  return CONNECTOR_CATALOG.find((connector) => connector.id === id);
}
