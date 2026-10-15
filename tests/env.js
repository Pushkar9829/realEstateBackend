// Test environment: isolated database on the local replica set, no worker loop.
process.env.NODE_ENV = 'test';
process.env.MONGO_URI = process.env.MONGO_URI_TEST || 'mongodb://127.0.0.1:27040/re_test?replicaSet=rs0&directConnection=true';
process.env.JOBS_ENABLED = 'false';
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789';
process.env.ENCRYPTION_KEY = 'a'.repeat(64);
process.env.OTP_PEPPER = 'test-pepper';
process.env.LOG_LEVEL = 'silent';
process.env.GEOCODER_PROVIDER = 'none'; // no network calls in tests
