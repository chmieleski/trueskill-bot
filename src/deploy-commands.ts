import { registerCommands } from './handlers/register-commands.js';

registerCommands().catch((error: unknown) => {
  console.error('[deploy] Failed to register commands:', error);
  process.exit(1);
});
