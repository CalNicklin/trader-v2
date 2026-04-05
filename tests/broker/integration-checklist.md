# IBKR Integration Test Checklist

Manual integration testing against IB Gateway paper account. Not automated — requires IB TWS or Gateway running.

## Prerequisites

- IB Gateway or TWS running in paper trading mode on port 4002
- `LIVE_TRADING_ENABLED=true` in environment
- `IBKR_PORT=4002` in environment

## Tests

### 1. Connection

```bash
LIVE_TRADING_ENABLED=true IBKR_PORT=4002 bun run src/broker/connection.ts
```

Verify: connects successfully, logs connection state, handles disconnect/reconnect.

### 2. Contract Lookup

After connection, verify `getContract("AAPL", "NASDAQ")` returns valid contract and `getContractDetails` works.

### 3. Order Placement (paper account only)

Place a small LIMIT BUY far below market price, verify it appears in open orders, then cancel it.

### 4. Guardian Loop

Insert a test position in `livePositions` with a stop-loss above current market price. Start guardian. Verify stop-loss sell is triggered within 60s.

### 5. Full Cycle

1. Seed a strategy with status="probation"
2. Set `LIVE_TRADING_ENABLED=true`
3. Run `runLiveExecutor()`
4. Verify it evaluates the strategy and respects capital allocation
