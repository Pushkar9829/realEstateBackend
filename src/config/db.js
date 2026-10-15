const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../core/logger');

mongoose.set('strictQuery', true);

async function connectDb(uri = env.MONGO_URI) {
  await mongoose.connect(uri, { autoIndex: !env.isProd, serverSelectionTimeoutMS: 10000 });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

async function disconnectDb() {
  await mongoose.disconnect();
}

function dbState() {
  return ['down', 'up', 'connecting', 'disconnecting'][mongoose.connection.readyState] || 'unknown';
}

module.exports = { connectDb, disconnectDb, dbState };
