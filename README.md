# Dividend Tracker

Google Sheets and Apps Script tools for holdings validation, dividend income tracking, projection-only reinvestment calculations, and payment reconciliation.

This public example uses synthetic account suffix `0000`. It contains no personal workbook, holdings export, payment history, credentials, or account reports. Projections never change actual holdings. Brokerage access and automatic dividend reference data are not configured.

## Tests

```sh
node --test tests/core.test.cjs tests/sheets.test.cjs
```

## Setup

Use a separate test spreadsheet. Add the files in `src` to its bound Apps Script project. Replace `YOUR_TEST_SPREADSHEET_ID` with your test-copy ID, review the account suffix setting for your own use, and run `configureAuthorizedTestCopy`. Review changes manually before enabling optional scheduling. See `IMPORT_SCHEMAS.md` for synthetic import formats.