// Process entry point: connect DB, start the job worker, listen.
const env = require('./config/env');
const logger = require('./core/logger');
const { connectDb, disconnectDb } = require('./config/db');
const { createApp } = require('./app');
const jobs = require('./jobs');

async function main() {
  await connectDb();
  jobs.registerAll();
  jobs.start();

  const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening'));

  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down');
    jobs.stop();
    server.close(async () => {
      await disconnectDb();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
