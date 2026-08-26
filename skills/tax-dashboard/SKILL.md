# Skill: tax-dashboard

Use when the operator drops invoices, receipts, or bank CSVs and wants a year dashboard.

## Inputs

- Folder of files (PDF, JPG, PNG, CSV, XLSX).
- Year and home currency from USER.md.
- Optional category map `out/tax/categories.yml`.

## Procedure

1. Master lists files, groups by likely type, plans one worker per batch of ~10 files.
2. Each worker extracts vendor, date, currency, amount, tax if present, category guess. Writes `jobs/<id>/rows/<file-stem>.json`.
3. Master concatenates rows, resolves duplicates (same vendor+date+amount), writes `out/tax/<year>/ledger.json`.
4. Master renders `out/tax/<year>/dashboard.html` (totals by month and category, list of unparsed files).
5. Never send identifiable tax files to a stealth / anonymous model unless `allow_stealth` is true.

## Output contract

```json
{
  "year": 2025,
  "currency": "NPR",
  "rows": [
    {
      "id": "inv-001",
      "source_file": "inbox/tax/2025/foo.pdf",
      "date": "2025-04-03",
      "vendor": "string",
      "amount": 0,
      "currency": "NPR",
      "category": "software | internet | travel | office | unknown",
      "confidence": 0.0
    }
  ]
}
```

## Done

Dashboard opens in a browser. Every source file is either a row or listed under "unparsed". Amounts are numbers, not prose. Stealth-model rule respected.
