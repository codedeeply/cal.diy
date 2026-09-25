/** biome-ignore-all lint/suspicious/noTsIgnore: e2e file */
import { createECDH, randomBytes, randomUUID } from "node:crypto";
import type { Environment } from "@/env";
import "dotenv/config";

const testAuthSecret = randomBytes(32).toString("base64");
const testVapidKeyPair = createECDH("prime256v1");
testVapidKeyPair.generateKeys();

const env: Partial<Omit<Environment, "NODE_ENV">> = {
  API_URL: "http://localhost",
  API_PORT: "5555",
  DATABASE_URL: "postgresql://postgres:@localhost:5450/calendso",
  DATABASE_READ_URL: "postgresql://postgres:@localhost:5450/calendso",
  DATABASE_WRITE_URL: "postgresql://postgres:@localhost:5450/calendso",
  NEXTAUTH_SECRET: testAuthSecret,
  JWT_SECRET: testAuthSecret,
  LOG_LEVEL: "trace",
  REDIS_URL: "redis://localhost:6379",
  STRIPE_API_KEY: "sk_test_51J4",
  STRIPE_WEBHOOK_SECRET: "whsec_51J4",
  IS_E2E: "true",
  API_KEY_PREFIX: "cal_test_",
  GET_LICENSE_KEY_URL: " https://console.cal.com/api/license",
  CALCOM_LICENSE_KEY: randomUUID(),
  RATE_LIMIT_DEFAULT_TTL_MS: 60000,
  // note(Lauris): setting high limit so that e2e tests themselves are not rate limited
  RATE_LIMIT_DEFAULT_LIMIT: 10000,
  RATE_LIMIT_DEFAULT_BLOCK_DURATION_MS: 60000,
  IS_TEAM_BILLING_ENABLED: false,
  ENABLE_SLOTS_WORKERS: "false",
  SLOTS_WORKER_POOL_SIZE: "0",
};

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
process.env = {
  ...env,
  ...process.env,
  // fake keys for testing
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: testVapidKeyPair.getPublicKey().toString("base64url"),
  VAPID_PRIVATE_KEY: testVapidKeyPair.getPrivateKey().toString("base64url"),
  CALENDSO_ENCRYPTION_KEY: randomBytes(16).toString("hex"),
  CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY: randomBytes(16).toString("hex"),
  INTEGRATION_TEST_MODE: "true",
  e2e: "true",
  SLOTS_CACHE_TTL: "1",
};
