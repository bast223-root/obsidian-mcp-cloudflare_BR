// Single source of truth for the server version. Read from package.json at
// build time (resolveJsonModule) so the MCP server version can never drift from
// the released version — bump package.json and it picks it up. The reported
// version is also what prompts Claude.ai clients to reload the tool registry.
import pkg from "../package.json";

export const VERSION: string = pkg.version;
