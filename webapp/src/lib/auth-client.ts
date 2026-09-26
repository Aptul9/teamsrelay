import { adminClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

// Same origin as the app: no baseURL needed in the browser
export const authClient = createAuthClient({ plugins: [adminClient()] });
