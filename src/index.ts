import './config.js'; // Load and validate env vars first — will exit if invalid
import express from 'express';
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

// Health check endpoint — use this to verify the server is running
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', server: 'mywallet-mcp', version: '1.0.0' });
});

// MCP protocol endpoint
app.all('/mcp', async (req, res) => {
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
