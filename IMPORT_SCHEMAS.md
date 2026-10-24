# Normalized manual imports

These schemas are designed for this project. They are not claimed to match a Robinhood download. Use JSON for the implemented fallback; a raw CSV must first be mapped/reviewed into these fields. The original source export should be retained with the batch. No automatic authentication is implied.

## Holdings object

| Field | Requirement |
|---|---|
| AccountSuffix | Exactly string `0000` |
| Source | Nonempty provenance; use `SYNTHETIC` for tests |
| SnapshotId | Nonempty stable snapshot identifier |
| RetrievedAt | ISO timestamp with explicit timezone, within 24 hours and no more than 5 minutes ahead |
| Status | `success` |
| Complete | Boolean `true`; adapter must have exhausted pagination |
| Positions | Array of position objects |
| EmptyVerified | Boolean `true` required to propose an empty snapshot |
| VerifiedMissingSymbols | Optional explicit array of missing/sold canonical symbols approved after reconciliation |
| ReconciliationEvidence | Required nonempty evidence when zeroing any missing symbols |

Each position requires `BrokerageSymbol` or `CanonicalSymbol`, decimal-string `Quantity` (nonnegative), `InstrumentType` (`stock`, `etf`, `listed_security`), and boolean `InstrumentVerified: true`. `BRK-B` maps explicitly to `BRK.B`; unknown alternate spellings are not guessed. Source decimal strings remain in the original batch while Sheets receives numeric values. Duplicate normalized symbols are rejected. A full response alone is not permission to zero missing holdings: they stay unchanged until verified, previewed and applied.

## Payment batch object

Top level: `Source`, string `AccountSuffix: "0000"`, boolean `Complete: true`, `Status: "success"`, array `Transactions`.

Each transaction requires:

| Field | Requirement |
|---|---|
| TransactionID | Stable source receipt identifier, not guessed from economic fields |
| PaymentDate | Valid account-local cash-credit date, exactly YYYY-MM-DD |
| Ticker | Resolved canonical symbol |
| NetAmount | Decimal string or number in USD; negative only for explicit reversals |
| GrossAmount, Withholding | Optional; when both are known, gross minus withholding must reconcile to net |
| Currency | `USD` only |
| Status | `paid`, `pending`, or `reversed` |
| EntryType | `dividend`, `distribution`, or `reversal` |
| RelatedTransactionID | Required original source ID for a negative reversal event |
| ImportedAt | Optional provenance timestamp; never a replacement payment date |

Dashboard `CalendarAmount` is derived from paid net cash; pending/reversed rows are excluded. DRIP purchase orders must not be imported as cash receipts. Source + TransactionID is the upsert key. Distinct IDs with equal dates/symbols/amounts both remain. Corrections overwrite that source event's current values; backup sheets preserve prior versions. No stable IDs means automated upserts are unavailable until a batch reconciliation policy is agreed.

Normalize timestamped receipts in the configured America/New_York timezone before producing PaymentDate. Do not truncate a UTC timestamp string to infer the account-local payment date. The current import deliberately accepts date-only values to make that adapter responsibility explicit.

## Dividend Data rows

`CanonicalSymbol, LatestRegularDistributionPerShare, AnnualDividendPerShare, AnnualizationMethod, Frequency, Currency, AsOf, Source, Status, Price, QuoteTicker`.

Enter actual verified payout/annual values and evidence. Unknown is blank, confirmed zero is numeric zero. Keep `Status` as `unverified` until reviewed; `verified` and `stale` are recognized by the script. `stale` preserves last good values with a visible status. Annual per-share amount is explicit and documented, not blindly inferred from latest payout. QuoteTicker is an explicit exchange-qualified GOOGLEFINANCE mapping; Price is the manual fallback. Currency must be USD. A variable or business-day distribution requires a documented annual estimate or sufficient verified TTM history, not payout times 4/12/365.
