import { registerCommands } from './handlers/register-commands.js';
import { createLogger } from './lib/logger.js';

const log = createLogger('deploy');

registerCommands()
  .then((count) => {
    log.info({ count }, 'Command deploy finished');
  })
  .catch((error: unknown) => {
    log.fatal({ err: error }, 'Failed to register commands');
    process.exit(1);
  });
