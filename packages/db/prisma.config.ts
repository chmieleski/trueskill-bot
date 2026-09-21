import { config as loadEnv } from 'dotenv';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, env } from 'prisma/config';

// Load monorepo root .env (packages/db → ../..)
loadEnv({ path: resolve(dirname(fileURLToPath(import.meta.url)), '../../.env') });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Prisma CLI (migrate/introspect) needs a direct connection — former directUrl
    url: env('DIRECT_URL'),
  },
});
