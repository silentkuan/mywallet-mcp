import './config.js'; // Load and validate env vars first — will exit if invalid
import express, { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './config.js';
import { registerTransactionTools } from './tools/transactions.js';
import { registerStockTools } from './tools/stocks.js';
import { registerBankAccountTools } from './tools/bankAccounts.js';
import { registerBankRecordTools } from './tools/bankRecords.js';
import { registerProfileTools } from './tools/profile.js';

// Create the MCP server instance
const server = new McpServer({
  name: 'mywallet-mcp',
  version: '1.0.0',
});

// Register all tool groups
registerTransactionTools(server);
registerStockTools(server);
registerBankAccountTools(server);
registerBankRecordTools(server);
registerProfileTools(server);

// Set up Express HTTP server with StreamableHTTP transport
const app = express();
app.use(express.json());

// Bearer token auth middleware — protects /mcp; /health remains public
function requireBearerToken(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.get('Authorization') ?? '';
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid Bearer token required' });
    return;
  }
  const provided = authHeader.slice(prefix.length);
  const expected = config.MCP_API_KEY;
  // Use constant-time comparison to prevent timing attacks
  let valid = false;
  try {
    valid =
      provided.length === expected.length &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    valid = false;
  }
  if (!valid) {
    res.status(401).json({ error: 'Unauthorized', message: 'Valid Bearer token required' });
    return;
  }
  next();
}

// Health check endpoint — use this to verify the server is running
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'mywallet-mcp', version: '1.0.0' });
});

// MCP protocol endpoint — requires Bearer token auth
app.all('/mcp', requireBearerToken, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless mode
  });
  res.on('close', () => {
    transport.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(config.PORT, () => {
  console.log(`✅ mywallet-mcp running on http://localhost:${config.PORT}`);
  console.log(`   MCP endpoint : http://localhost:${config.PORT}/mcp`);
  console.log(`   Health check : http://localhost:${config.PORT}/health`);
  console.log(`   User ID      : ${config.TARGET_USER_ID}`);
});
