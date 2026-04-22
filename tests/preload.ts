process.env.ANTHROPIC_API_KEY = "test-key";
process.env.RESEND_API_KEY = "test-key";
process.env.ALERT_EMAIL_TO = "test@example.com";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DB_PATH = ":memory:";
process.env.IBKR_HOST = "127.0.0.1";
process.env.IBKR_PORT = "4002";
process.env.IBKR_CLIENT_ID = "99";
process.env.LIVE_TRADING_ENABLED = "false";
// Keep slippage off by default in tests — TRA-6's behaviour has its own test
// file (`tests/paper/slippage.test.ts`) and opts in explicitly when needed.
// Signal-logic tests assert specific fill prices and should not pick up a
// haircut unless they explicitly set this env.
process.env.PAPER_SLIPPAGE_BPS = "0";
