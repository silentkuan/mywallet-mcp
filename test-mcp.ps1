$BASE = "http://localhost:3000"
$HEADERS = @{ "Accept" = "application/json, text/event-stream" }
$results = @()

function Invoke-MCP($tool, $args_body) {
    $body = @{
        jsonrpc = "2.0"; id = 1; method = "tools/call"
        params  = @{ name = $tool; arguments = $args_body }
    } | ConvertTo-Json -Depth 8 -Compress
    try {
        $r = Invoke-WebRequest -Uri "$BASE/mcp" -Method POST `
            -ContentType "application/json" -Headers $HEADERS `
            -Body $body -UseBasicParsing -ErrorAction Stop
        $content = $r.Content -replace "^event: message\r?\ndata: ", ""
        $parsed = $content | ConvertFrom-Json
        if ($parsed.error) {
            return @{ ok = $false; data = $parsed.error.message }
        }
        $text = $parsed.result.content[0].text
        $json = $text | ConvertFrom-Json
        return @{ ok = $true; data = $json }
    } catch {
        return @{ ok = $false; data = $_.Exception.Message }
    }
}

function Log($label, $result) {
    $status = if ($result.ok) { "PASS" } else { "FAIL" }
    $script:results += [PSCustomObject]@{ Tool = $label; Status = $status; Notes = "" }
    Write-Host "`n--- $label [$status] ---" -ForegroundColor $(if ($result.ok) { "Green" } else { "Red" })
    if ($result.ok) {
        $result.data | ConvertTo-Json -Depth 6 | Write-Host
    } else {
        Write-Host "ERROR: $($result.data)" -ForegroundColor Red
    }
}

# ─── 1. Health ────────────────────────────────────────────────────────────────
Write-Host "`n========== HEALTH CHECK ==========" -ForegroundColor Yellow
try {
    $h = Invoke-WebRequest -Uri "$BASE/health" -UseBasicParsing
    $healthOk = ($h.Content | ConvertFrom-Json).status -eq "ok"
    $results += [PSCustomObject]@{ Tool = "GET /health"; Status = if ($healthOk) { "PASS" } else { "FAIL" }; Notes = $h.Content }
    Write-Host "Health: $($h.Content)" -ForegroundColor $(if ($healthOk) { "Green" } else { "Red" })
} catch { $results += [PSCustomObject]@{ Tool = "GET /health"; Status = "FAIL"; Notes = $_.Exception.Message } }

# ─── 2. Profile ───────────────────────────────────────────────────────────────
Write-Host "`n========== PROFILE TOOLS ==========" -ForegroundColor Yellow
Log "get_profile"   (Invoke-MCP "get_profile"  @{})
Log "get_settings"  (Invoke-MCP "get_settings" @{})

# ─── 3. Transactions ──────────────────────────────────────────────────────────
Write-Host "`n========== TRANSACTION TOOLS ==========" -ForegroundColor Yellow
$getTx = Invoke-MCP "get_transactions" @{}
if ($getTx.ok) {
    $all = $getTx.data
    $getTx.data = if ($all.Count -gt 10) { $all[0..9] } else { $all }
}
Log "get_transactions (first 10)" $getTx

# Add test transaction
$addTx = Invoke-MCP "add_transaction" @{
    date = "2026-04-30"; amount = 9.99; currency = "MYR"
    type = "EXPENSE"; category = "TEST_MCP"; remark = "MCP test entry - safe to delete"
}
Log "add_transaction" $addTx

if ($addTx.ok) {
    $txId = $addTx.data.id
    # Update it
    $updTx = Invoke-MCP "update_transaction" @{ id = $txId; remark = "MCP test entry - updated" }
    Log "update_transaction" $updTx
    # Delete it
    $delTx = Invoke-MCP "delete_transaction" @{ id = $txId }
    Log "delete_transaction" $delTx
    if ($delTx.ok) { $results[-1].Notes = "Cleaned up test data" }
} else {
    $results += [PSCustomObject]@{ Tool = "update_transaction"; Status = "SKIP"; Notes = "add failed" }
    $results += [PSCustomObject]@{ Tool = "delete_transaction"; Status = "SKIP"; Notes = "add failed" }
}

# ─── 4. Stocks ────────────────────────────────────────────────────────────────
Write-Host "`n========== STOCK TOOLS ==========" -ForegroundColor Yellow
$getStk = Invoke-MCP "get_stock_transactions" @{}
if ($getStk.ok) {
    $all = $getStk.data
    $getStk.data = if ($all.Count -gt 10) { $all[0..9] } else { $all }
}
Log "get_stock_transactions (first 10)" $getStk

$addStk = Invoke-MCP "add_stock_transaction" @{
    symbol = "TEST"; market = "US"; action = "BUY"
    date = "2026-04-30"; quantity = 1; pricePerShare = 1.00
    currency = "USD"; totalAmount = 1.00
}
Log "add_stock_transaction" $addStk

if ($addStk.ok) {
    $stkId = $addStk.data.id
    $updStk = Invoke-MCP "update_stock_transaction" @{ id = $stkId; fees = 0.50 }
    Log "update_stock_transaction" $updStk
    $delStk = Invoke-MCP "delete_stock_transaction" @{ id = $stkId }
    Log "delete_stock_transaction" $delStk
    if ($delStk.ok) { $results[-1].Notes = "Cleaned up test data" }
} else {
    $results += [PSCustomObject]@{ Tool = "update_stock_transaction"; Status = "SKIP"; Notes = "add failed" }
    $results += [PSCustomObject]@{ Tool = "delete_stock_transaction"; Status = "SKIP"; Notes = "add failed" }
}

# ─── 5. Bank Accounts ─────────────────────────────────────────────────────────
Write-Host "`n========== BANK ACCOUNT TOOLS ==========" -ForegroundColor Yellow
$getBA = Invoke-MCP "get_bank_accounts" @{}
if ($getBA.ok) {
    $all = $getBA.data
    $getBA.data = if ($all.Count -gt 10) { $all[0..9] } else { $all }
}
Log "get_bank_accounts (first 10)" $getBA

$addBA = Invoke-MCP "add_bank_account" @{
    name = "TEST_MCP_BANK"; type = "Savings"; currency = "MYR"; order = 999
}
Log "add_bank_account" $addBA

if ($addBA.ok) {
    $baId = $addBA.data.id
    $delBA = Invoke-MCP "delete_bank_account" @{ id = $baId }
    Log "delete_bank_account" $delBA
    if ($delBA.ok) { $results[-1].Notes = "Cleaned up test data" }
} else {
    $results += [PSCustomObject]@{ Tool = "delete_bank_account"; Status = "SKIP"; Notes = "add failed" }
}

# ─── 6. Bank Records ──────────────────────────────────────────────────────────
Write-Host "`n========== BANK RECORD TOOLS ==========" -ForegroundColor Yellow
$getBR = Invoke-MCP "get_bank_records" @{}
if ($getBR.ok) {
    $all = $getBR.data
    $getBR.data = if ($all.Count -gt 10) { $all[0..9] } else { $all }
}
Log "get_bank_records (first 10)" $getBR

# Use a fake bankId so it doesn't touch real data; we'll delete this after
$fakeBankId = "test-mcp-bank-99999"
$upsertBR = Invoke-MCP "update_bank_record" @{
    bankId = $fakeBankId; month = "2026-04"; balance = 0.01
}
Log "update_bank_record (upsert)" $upsertBR
# Note: there's no delete_bank_record — so we leave balance=0.01 under fake id

# ─── SUMMARY ──────────────────────────────────────────────────────────────────
Write-Host "`n`n========================================" -ForegroundColor Yellow
Write-Host "           MCP TEST REPORT SUMMARY" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
$pass = ($results | Where-Object { $_.Status -eq "PASS" }).Count
$fail = ($results | Where-Object { $_.Status -eq "FAIL" }).Count
$skip = ($results | Where-Object { $_.Status -eq "SKIP" }).Count
$total = $results.Count
Write-Host "Total: $total  |  PASS: $pass  |  FAIL: $fail  |  SKIP: $skip" -ForegroundColor White
Write-Host ""
$results | Format-Table -AutoSize
