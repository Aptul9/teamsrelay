import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same origin as the app: no baseURL needed in the browser. oauthProviderClient: a sign-in on a page better-auth opened
// for an MCP client (OAuth) carries the signed query of the page, so that better-auth goes on to the consent screen.
export const authClient = createAuthClient({ plugins: [adminClient(), oauthProviderClient()] });
