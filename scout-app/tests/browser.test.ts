import { describe, expect, it } from "vitest";
import {
  filterBrowserPages,
  isAllowedBrowserUrl,
  isBrowserReadTool,
  isBrowserTool,
  normalizeAllowedDomains,
  parseBrowserPages,
} from "../src/lib/browser";

describe("browser connector policy", () => {
  it("normalizes domains without widening lookalike hosts", () => {
    const domains = normalizeAllowedDomains(["https://Mail.Google.com/inbox, *.slack.com\nmail.google.com"]);
    expect(domains).toEqual(["mail.google.com", "slack.com"]);
    expect(isAllowedBrowserUrl("https://mail.google.com/mail/u/0", "allowed_sites", domains)).toBe(true);
    expect(isAllowedBrowserUrl("https://files.slack.com/a", "allowed_sites", domains)).toBe(true);
    expect(isAllowedBrowserUrl("https://evilslack.com/a", "allowed_sites", domains)).toBe(false);
  });

  it("blocks non-web and insecure remote schemes", () => {
    expect(isAllowedBrowserUrl("file:///tmp/private", "full_profile", [])).toBe(false);
    expect(isAllowedBrowserUrl("chrome://password-manager", "full_profile", [])).toBe(false);
    expect(isAllowedBrowserUrl("http://example.com", "full_profile", [])).toBe(false);
    expect(isAllowedBrowserUrl("http://localhost:1420", "full_profile", [])).toBe(true);
  });

  it("keeps current-tab navigation on the same origin", () => {
    expect(isAllowedBrowserUrl("https://app.example.com/two", "current_tab", [], "https://app.example.com/one")).toBe(true);
    expect(isAllowedBrowserUrl("https://admin.example.com", "current_tab", [], "https://app.example.com/one")).toBe(false);
  });

  it("parses and filters the Chrome page list", () => {
    const pages = parseBrowserPages(`## Pages\n1: https://mail.google.com/mail [selected]\n2: https://bank.example/account\n3: chrome://settings`);
    expect(pages).toEqual([
      { pageId: 1, url: "https://mail.google.com/mail", selected: true },
      { pageId: 2, url: "https://bank.example/account", selected: false },
    ]);
    expect(filterBrowserPages(pages, "allowed_sites", ["mail.google.com"])).toEqual([pages[0]]);
    expect(filterBrowserPages(pages, "current_tab", [])).toEqual([pages[0]]);
  });

  it("only marks observation tools as sweep-readable", () => {
    expect(isBrowserTool("browser_read_page")).toBe(true);
    expect(isBrowserReadTool("browser_read_page")).toBe(true);
    expect(isBrowserReadTool("browser_select_tab")).toBe(true);
    expect(isBrowserReadTool("browser_click")).toBe(false);
    expect(isBrowserReadTool("browser_fill_form")).toBe(false);
  });
});
