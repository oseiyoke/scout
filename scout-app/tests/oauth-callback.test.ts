import { describe, expect, it } from "vitest";
import { createOAuthCallbackWaiter } from "../src/lib/oauth";

describe("OAuth callback waiter", () => {
  it("returns after subscribing instead of waiting for the browser callback", async () => {
    let emit: ((payload: { connectorId: string; url?: string; error?: string }) => void) | undefined;
    let disposed = false;
    const waiter = await createOAuthCallbackWaiter(
      "notion-1",
      async (handler) => {
        emit = handler;
        return () => { disposed = true; };
      },
      1_000,
    );

    let callbackResolved = false;
    void waiter.result.then(() => { callbackResolved = true; });
    await Promise.resolve();
    expect(callbackResolved).toBe(false);

    emit?.({
      connectorId: "notion-1",
      url: "http://127.0.0.1:3119/oauth/callback?code=ok&state=safe",
    });
    await expect(waiter.result).resolves.toContain("code=ok");
    expect(disposed).toBe(true);
  });

  it("ignores callback events for another connector", async () => {
    let emit: ((payload: { connectorId: string; url?: string; error?: string }) => void) | undefined;
    const waiter = await createOAuthCallbackWaiter(
      "notion-1",
      async (handler) => {
        emit = handler;
        return () => {};
      },
      1_000,
    );

    emit?.({ connectorId: "custom-1", url: "http://127.0.0.1:3119/oauth/callback?code=wrong" });
    let callbackResolved = false;
    void waiter.result.then(() => { callbackResolved = true; });
    await Promise.resolve();
    expect(callbackResolved).toBe(false);
    waiter.dispose();
  });
});
