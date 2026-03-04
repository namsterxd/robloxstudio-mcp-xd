import { RobloxStudioMCPServer, getAllTools } from '@robloxstudio-mcp/core';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { version: VERSION } = require('../package.json');

const server = new RobloxStudioMCPServer({
  name: 'robloxstudio-mcp-xd',
  version: VERSION,
  tools: getAllTools(),
});

server.run().catch((error) => {
  console.error('Server failed to start:', error);
  process.exit(1);
});
