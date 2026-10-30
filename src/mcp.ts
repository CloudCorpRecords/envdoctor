/**
 * envdoctor MCP server. Tool: doctor_env.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "envdoctor", version: VERSION });

server.tool(
  "doctor_env",
  "Run environment checks for a repo directory: node version satisfies package.json engines, git is available, the expected lockfile for the project exists, a .env file is present when .env.example declares one is needed (only key names compared, values never read), and npm is on PATH. Each check reports pass or fail with the fix. Verdict HEALTHY or ISSUES.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
