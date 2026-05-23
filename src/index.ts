import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { ObsidianMCP } from "./mcp/agent";
import AuthHandler from "./auth/handler";

export { ObsidianMCP };

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: ObsidianMCP.serve("/mcp") as never,
  defaultHandler: AuthHandler as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
});
