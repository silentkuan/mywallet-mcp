# mywallet-mcp

**Version:** 1.0.0  
**Protocol:** Model Context Protocol (MCP)  
**Transport:** StreamableHTTP, stateless

MCP server for mywalletAI. Exposes personal finance CRUD tools over HTTP, backed by Cloud Firestore. All data operations are scoped to a single fixed user (set via `TARGET_USER_ID` environment variable).

---

## Connection Info

| Property | Value |
|---|---|
| MCP endpoint | `POST /mcp` |
| Health check | `GET /health` |
| Protocol version | `2024-11-05` |
| Transport | StreamableHTTP (stateless — no session ID) |
| Content-Type | `application/json` |
| Accept | `application/json, text/event-stream` |

**Health check response:**
```json
{ "status": "ok", "server": "mywallet-mcp", "version": "1.0.0" }
```

**Connecting from a client (example config):**
```json
{
  "mcpServers": {
    "mywallet": {
      "type": "http",
      "url": "https://<your-host>/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_API_KEY>"
      }
    }
  }
}
```

---

## Authentication / Environment Variables

All variables must be set before the server starts. The server will exit immediately with an error if any required variable is missing or invalid.

| Variable | Required | Description |
|---|---|---|
| `FIREBASE_PROJECT_ID` | ✅ | Firebase project ID |
| `FIREBASE_CLIENT_EMAIL` | ✅ | Firebase service account client email (must be valid email format) |
| `FIREBASE_PRIVATE_KEY` | ✅ | Firebase service account private key. Literal `\n` sequences are automatically converted to real newlines. |
| `TARGET_USER_ID` | ✅ | Firestore user document ID. **Fixed at server startup — never accept from model input.** All tool calls operate on this user's data. |
| `MW_PRIVACY_KEY` | ✅ | AES key matching the frontend `localStorage` key `MW_PRIVACY_KEY`. Used to decrypt encrypted Firestore fields. |
| `MCP_API_KEY` | ✅ | Secret Bearer token that clients must supply in the `Authorization: Bearer <token>` header on every request to `/mcp`. |
| `PORT` | ❌ | HTTP listen port. Defaults to `3000`. |

---

## Available Tools

### Tool response format

All tools return a single `content` array with one text item containing a JSON string:

```json
{
  "content": [
    { "type": "text", "text": "<JSON string>" }
  ]
}
```

Parse `content[0].text` as JSON to get the structured result.

---

### 1. Transactions

#### `get_transactions`

Get all financial transactions. Optionally filter by date range, type, or category.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `startDate` | `string` | No | Filter from this date inclusive. Format: `YYYY-MM-DD`. |
| `endDate` | `string` | No | Filter to this date inclusive. Format: `YYYY-MM-DD`. |
| `type` | `"INCOME" \| "EXPENSE"` | No | Filter by transaction type. |
| `category` | `string` | No | Filter by category name (exact match, case-sensitive). |

**Returns:** JSON array of `Transaction` objects (see [Data Schemas](#data-schemas)).

---

#### `add_transaction`

Add a new financial transaction (income or expense).

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `date` | `string` | ✅ | Transaction date. Format: `YYYY-MM-DD`. |
| `amount` | `number` | ✅ | Transaction amount. Must be a positive number. |
| `currency` | `"MYR" \| "SGD" \| "USD"` | ✅ | Currency code. |
| `type` | `"INCOME" \| "EXPENSE"` | ✅ | Transaction type. |
| `category` | `string` | ✅ | Category name. Must be non-empty. |
| `remark` | `string` | No | Optional note or description. |
| `calories` | `number` | No | Calories (for food expenses only). |
| `recurrence` | `"MONTHLY" \| "WEEKLY" \| "YEARLY" \| null` | No | Repeat frequency. |
| `tax` | `number` | No | Tax amount if applicable. |

**Returns:**
```json
{
  "success": true,
  "id": "tx-<timestamp>-<random>",
  "transaction": { /* Transaction object */ }
}
```

---

#### `update_transaction`

Update an existing transaction by its id. Only provide fields to change; unspecified fields retain their current values.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Transaction id to update. |
| `date` | `string` | No | New date. Format: `YYYY-MM-DD`. |
| `amount` | `number` | No | New amount. Must be positive. |
| `currency` | `"MYR" \| "SGD" \| "USD"` | No | New currency. |
| `type` | `"INCOME" \| "EXPENSE"` | No | New type. |
| `category` | `string` | No | New category. |
| `remark` | `string` | No | New remark. |
| `calories` | `number` | No | New calories value. |
| `recurrence` | `"MONTHLY" \| "WEEKLY" \| "YEARLY" \| null` | No | New recurrence. |
| `tax` | `number` | No | New tax amount. |

**Returns on success:**
```json
{ "success": true, "id": "<id>", "transaction": { /* updated Transaction */ } }
```

**Returns when not found:**
```json
{ "success": false, "error": "Transaction <id> not found" }
```

---

#### `delete_transaction`

Delete a financial transaction by its id.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Transaction id to delete. |

**Returns:**
```json
{ "success": true, "deleted": "<id>" }
```

---

### 2. Stock Transactions

#### `get_stock_transactions`

Get all stock transactions (buy, sell, dividend). Optionally filter by symbol, action, or market.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | `string` | No | Filter by stock ticker symbol (e.g. `AAPL`). Case-insensitive. |
| `action` | `"BUY" \| "SELL" \| "DIVIDEND"` | No | Filter by action type. |
| `market` | `"US" \| "MY" \| "SG"` | No | Filter by stock market. |

**Returns:** JSON array of `StockTransaction` objects (see [Data Schemas](#data-schemas)).

---

#### `add_stock_transaction`

Add a new stock transaction (buy, sell, or dividend).

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `symbol` | `string` | ✅ | Stock ticker symbol (e.g. `AAPL`, `MAYBANK`). Stored uppercased. |
| `market` | `"US" \| "MY" \| "SG"` | ✅ | Stock market. |
| `action` | `"BUY" \| "SELL" \| "DIVIDEND"` | ✅ | Action type. |
| `date` | `string` | ✅ | Transaction date. Format: `YYYY-MM-DD`. |
| `quantity` | `number` | ✅ | Number of shares. Use `0` for dividend entries. |
| `pricePerShare` | `number` | ✅ | Price per share. Use `0` for dividend entries. |
| `currency` | `"MYR" \| "SGD" \| "USD"` | ✅ | Currency. |
| `totalAmount` | `number` | ✅ | Total transaction amount. |
| `fees` | `number` | No | Transaction fees or stamp duty. |
| `tax` | `number` | No | Dividend withholding tax. |
| `costBasis` | `number` | No | Cost basis per share (typically used for sell records). |
| `excludeFromHoldings` | `boolean` | No | When `true`, this record is excluded from position/holdings calculations. |

**Returns:**
```json
{
  "success": true,
  "id": "stk-<timestamp>-<random>",
  "transaction": { /* StockTransaction object */ }
}
```

---

#### `update_stock_transaction`

Update an existing stock transaction by its id. Only provide fields to change.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Stock transaction id to update. |
| `symbol` | `string` | No | New ticker symbol. |
| `market` | `"US" \| "MY" \| "SG"` | No | New market. |
| `action` | `"BUY" \| "SELL" \| "DIVIDEND"` | No | New action. |
| `date` | `string` | No | New date. Format: `YYYY-MM-DD`. |
| `quantity` | `number` | No | New quantity. |
| `pricePerShare` | `number` | No | New price per share. |
| `currency` | `"MYR" \| "SGD" \| "USD"` | No | New currency. |
| `totalAmount` | `number` | No | New total amount. |
| `fees` | `number` | No | New fees. |
| `tax` | `number` | No | New tax. |
| `costBasis` | `number` | No | New cost basis. |
| `excludeFromHoldings` | `boolean` | No | New exclusion flag. |

**Returns on success:**
```json
{ "success": true, "id": "<id>", "transaction": { /* updated StockTransaction */ } }
```

**Returns when not found:**
```json
{ "success": false, "error": "Stock transaction <id> not found" }
```

---

#### `delete_stock_transaction`

Delete a stock transaction by its id.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Stock transaction id to delete. |

**Returns:**
```json
{ "success": true, "deleted": "<id>" }
```

---

### 3. Bank Accounts

#### `get_bank_accounts`

Get all bank accounts and e-wallet accounts.

**Input parameters:** none

**Returns:** JSON array of `BankAccount` objects (see [Data Schemas](#data-schemas)).

---

#### `add_bank_account`

Add a new bank account or e-wallet.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `name` | `string` | ✅ | Account name (e.g. `Maybank`, `Touch n Go`). |
| `type` | `string` | ✅ | Account type (e.g. `Savings`, `Current`, `E-Wallet`, `Cash`). |
| `currency` | `"MYR" \| "SGD" \| "USD"` | ✅ | Default currency for this account. |
| `order` | `number` | No | Display sort order (lower = shown first). |

**Returns:**
```json
{
  "success": true,
  "id": "bank-<timestamp>-<random>",
  "account": { /* BankAccount object */ }
}
```

---

#### `delete_bank_account`

Delete a bank account by its id.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | ✅ | Bank account id to delete. |

**Returns:**
```json
{ "success": true, "deleted": "<id>" }
```

---

### 4. Bank Balance Records

#### `get_bank_records`

Get monthly bank balance records. Optionally filter by bank account id or month.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `bankId` | `string` | No | Filter by bank account id. |
| `month` | `string` | No | Filter by month. Format: `YYYY-MM`. |

**Returns:** JSON array of `BankBalanceRecord` objects (see [Data Schemas](#data-schemas)).

---

#### `update_bank_record`

Set or update the end-of-month balance for a bank account. Creates the record if it does not exist (upsert).

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `bankId` | `string` | ✅ | Bank account id. |
| `month` | `string` | ✅ | Month. Format: `YYYY-MM`. |
| `balance` | `number` | ✅ | End-of-month balance amount. |

**Returns:**
```json
{
  "success": true,
  "id": "<bankId>-<month>",
  "record": { /* BankBalanceRecord object */ }
}
```

The `id` field is always the composite `<bankId>-<month>` string, matching the frontend convention.

---

### 5. Profile & Settings

#### `get_profile`

Get the user personal profile (gender, age, height, weight, activity level).

**Input parameters:** none

**Returns when found:** `UserProfile` object (see [Data Schemas](#data-schemas)).

**Returns when not found:**
```json
{ "found": false, "profile": null }
```

---

#### `get_settings`

Get the user settings including custom expense/income categories and transaction shortcuts.

**Input parameters:** none

**Returns:** `UserSettings` object. If no settings exist, returns empty defaults:
```json
{
  "customExpenseCategories": [],
  "customIncomeCategories": [],
  "transactionShortcuts": []
}
```

---

#### `update_profile`

Update the user personal profile. Only provide fields to change; unspecified fields retain their current values.

**Input parameters:**

| Parameter | Type | Required | Description |
|---|---|---|---|
| `gender` | `"male" \| "female"` | No | User gender. |
| `age` | `integer` | No | User age in years. Must be a positive integer. |
| `height` | `number` | No | Height in cm. Must be positive. |
| `weight` | `number` | No | Weight in kg. Must be positive. |
| `activityLevel` | `number` | No | Activity level multiplier used for calorie calculations. |

**Returns:**
```json
{ "success": true, "profile": { /* updated UserProfile */ } }
```

---

## Data Schemas

### `Transaction`

```typescript
{
  id: string;                                            // e.g. "tx-1715000000000-abc12"
  date: string;                                          // YYYY-MM-DD
  amount: number;                                        // positive
  currency: "MYR" | "SGD" | "USD";
  type: "INCOME" | "EXPENSE";
  category: string;
  remark?: string;
  calories?: number;
  recurrence?: "MONTHLY" | "WEEKLY" | "YEARLY" | null;
  recurrenceId?: string;
  recurrenceCount?: number;
  tax?: number;
  encryptedData?: string;                                // present if record is encrypted
  _decryptionFailed?: boolean;                           // true if decryption failed
}
```

### `StockTransaction`

```typescript
{
  id: string;                                            // e.g. "stk-1715000000000-abc12"
  symbol: string;                                        // uppercase ticker, e.g. "AAPL"
  market: "US" | "MY" | "SG";
  action: "BUY" | "SELL" | "DIVIDEND";
  date: string;                                          // YYYY-MM-DD
  quantity: number;                                      // 0 for dividend
  pricePerShare: number;                                 // 0 for dividend
  currency: "MYR" | "SGD" | "USD";
  totalAmount: number;
  fees?: number;
  tax?: number;
  costBasis?: number;
  excludeFromHoldings?: boolean;
  encryptedData?: string;
  _decryptionFailed?: boolean;
}
```

### `BankAccount`

```typescript
{
  id: string;                                            // e.g. "bank-1715000000000-abc12"
  name: string;                                          // e.g. "Maybank"
  type: string;                                          // e.g. "Savings", "E-Wallet"
  currency: "MYR" | "SGD" | "USD";
  order?: number;
  encryptedData?: string;
}
```

### `BankBalanceRecord`

```typescript
{
  id: string;                                            // composite: "<bankId>-<month>"
  bankId: string;
  month: string;                                         // YYYY-MM
  balance: number;
  encryptedData?: string;
}
```

### `UserProfile`

```typescript
{
  gender: "male" | "female";
  age: number;
  height: number;                                        // cm
  weight: number;                                        // kg
  activityLevel?: number;                                // multiplier for calorie calculation
}
```

### `UserSettings`

```typescript
{
  customExpenseCategories: string[];
  customIncomeCategories: string[];
  transactionShortcuts: TransactionShortcut[];
}
```

### `TransactionShortcut`

```typescript
{
  id: string;
  name: string;
  type: "INCOME" | "EXPENSE";
  amount?: number;
  currency: "MYR" | "SGD" | "USD";
  category: string;
  remark?: string;
  calories?: number;
  icon?: string;
}
```

---

## Usage Examples

All requests are JSON-RPC 2.0 sent to `POST /mcp` with headers:
- `Content-Type: application/json`
- `Accept: application/json, text/event-stream`

### List all tools

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/list",
  "params": {}
}
```

### Get profile

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "get_profile",
    "arguments": {}
  }
}
```

### Get transactions filtered by date range and type

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "get_transactions",
    "arguments": {
      "startDate": "2025-01-01",
      "endDate": "2025-01-31",
      "type": "EXPENSE"
    }
  }
}
```

### Add an expense transaction

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "add_transaction",
    "arguments": {
      "date": "2025-05-06",
      "amount": 12.50,
      "currency": "MYR",
      "type": "EXPENSE",
      "category": "Food",
      "remark": "Lunch",
      "calories": 650
    }
  }
}
```

### Add a stock buy

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "add_stock_transaction",
    "arguments": {
      "symbol": "AAPL",
      "market": "US",
      "action": "BUY",
      "date": "2025-05-06",
      "quantity": 10,
      "pricePerShare": 185.00,
      "currency": "USD",
      "totalAmount": 1850.00,
      "fees": 1.00
    }
  }
}
```

### Set end-of-month bank balance

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "update_bank_record",
    "arguments": {
      "bankId": "bank-1715000000000-abc12",
      "month": "2025-04",
      "balance": 4200.00
    }
  }
}
```

---

## Error Handling

### MCP-level errors

If a required parameter is missing or has an invalid type/value, the MCP SDK returns a JSON-RPC error response:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32602,
    "message": "Invalid params",
    "data": { /* zod validation details */ }
  }
}
```

### Tool-level errors (not-found)

When a resource is not found (e.g. updating a non-existent transaction), the tool returns a successful JSON-RPC response but with `success: false` in the text payload:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"success\": false, \"error\": \"Transaction tx-999 not found\"}"
      }
    ]
  }
}
```

Always check `JSON.parse(result.content[0].text).success` for write operations.

### Server startup errors

If any required environment variable is missing or invalid, the process exits immediately with code `1` and prints a formatted error to stderr.

---

## Notes for AI Agents

1. **`TARGET_USER_ID` is fixed.** It is set from the server environment variable and cannot be overridden by any tool argument. All data operations are automatically scoped to this user. Do not attempt to pass a user id to any tool.

2. **Id format.** Generated ids follow these patterns:
   - Transactions: `tx-<unix-ms>-<5-char-random>`
   - Stock transactions: `stk-<unix-ms>-<5-char-random>`
   - Bank accounts: `bank-<unix-ms>-<5-char-random>`
   - Bank records: `<bankId>-<YYYY-MM>` (composite, deterministic)

3. **Date formats.** All dates use `YYYY-MM-DD`. All months use `YYYY-MM`. There is no timezone conversion — dates are stored as-is.

4. **Currency.** All monetary amounts are plain numbers without currency conversion. The `currency` field is a label only.

5. **Encrypted records.** Some Firestore documents may contain an `encryptedData` field. If decryption fails, `_decryptionFailed: true` is set on the returned object and other fields may be missing or stale. This is a read-only artefact — do not attempt to write `encryptedData` directly via the tools.

6. **Upsert vs. create for bank records.** `update_bank_record` always upserts — it creates the record if `<bankId>-<month>` does not exist, or replaces it if it does. There is no separate create operation for bank records.

7. **Stateless transport.** Each MCP request is fully independent. There is no session state between calls. Do not rely on server-side conversation memory.

8. **`excludeFromHoldings`.** When set to `true` on a stock transaction, that record is excluded from position/portfolio calculations in the frontend. Use this for adjustments or data corrections that should not affect reported holdings.
