# Frozen summary charts — Draft review method

This adds a presentation candidate; it does not change the frozen data or grant
permission to publish it. The proposed **Other records** label requires Claude
review. The requested “Not passed” label is not supported by the complement.

Run locally with Node.js 22 or newer, from the repository root:

```sh
node bin/reproduce-summary-charts.js --out results/summary-charts-review
```

The directory must not exist. This offline command reads only the two fixed
local inputs and creates a numerical JSON summary, two charts, a 1200×630 SVG,
an accessible HTML review and a hash manifest. It makes no network requests.
An interrupted output is retained; choose a new directory instead of overwriting.

## Source and denominator

- Selected CSV: `data/2026-09-29/data.csv`, SHA-256
  `be429676b07fa0bd6077311c8368110b79bf43aadc9806c8d58fbf84a821cff5`.
- Full population: `data/2026-09-29/snapshot.json`, SHA-256
  `f4cc0e6c8634813841cfae23cfed41dcf2d1e3abda302c8f6396c8047e8e7096`.

Both byte hashes are required before calculation. The full population is
reclassified, and its selected records must reproduce the exact CSV bytes.
A is 377 of 3,762 records (10.0213%, displayed as 10%). The 377-row CSV alone
does not supply the denominator. The complement is 3,385 (89.9787%, displayed
as 90%): 2,842 ESTIMATED dates after the reference, 540 ACTUAL dates on or before
it, and 3 ACTUAL dates after it. “Other records” means records not meeting A;
it does not imply that all their dates are future dates.

The source was observed on 29 September 2026. The calculation reference is
31 August 2026. This is not a historical registry reconstruction at 31 August.

## Calendar-month bins

An estimated primary completion interval qualifies when it ends **on or before**
the reference. Equality is included. DAY dates use their exact date; MONTH dates
use the last day of their month as a derived chart endpoint, not an asserted
exact source day. Original MONTH `days_after_estimated_date` CSV cells remain
`UNAVAILABLE`; this script does not rewrite the CSV.

Subtract 3, 6, 12 and 24 calendar months from 2026-08-31, clamping to the last
valid day of the target month. This gives 2026-05-31, 2026-02-28, 2025-08-31 and
2024-08-31. Assign each endpoint to exactly one interval:

| Elapsed calendar months | Endpoint interval | DAY | MONTH | Records |
| --- | --- | ---: | ---: | ---: |
| [0, 3] | [2026-05-31, 2026-08-31] | 88 | 60 | 148 |
| (3, 6] | [2026-02-28, 2026-05-31) | 38 | 23 | 61 |
| (6, 12] | [2025-08-31, 2026-02-28) | 52 | 38 | 90 |
| (12, 24] | [2024-08-31, 2025-08-31) | 37 | 23 | 60 |
| >24 | before 2024-08-31 | 9 | 9 | 18 |
| Total | | 224 | 153 | 377 |

Equality at 3, 6, 12 and 24 months enters the younger inclusive bucket.
The bins have unequal widths. Equal-width bars display record counts, not a
histogram density, and their numeric axes start at zero.

## Elapsed statistics and precision

All 377 interval endpoints have median 153 days and longest 2,650 days.
This includes 31 endpoints equal to the reference: 11 DAY and 20 MONTH records.

The existing Wall statistics independently use only 224 DAY records and have
the same median and longest values. Its 153 MONTH records remain excluded from
its original elapsed-day statistics; its method and image are unchanged.
The new all-endpoint result and the original DAY-only result must not be conflated.

The SVGs include titles and descriptions. The HTML provides visible numeric
tables, so small-screen readers need not rely on a shrunken figure or color.
The social SVG uses only the proportion chart and dated source context.

`src/summary-charts.js` exports pure `computeSummary({csvBytes, snapshotBytes})`,
`proportionSvg(summary)`, `distributionSvg(summary)`, `socialSvg(summary)` and
`renderHtml(summary)`. Boundary helpers are exported for offline tests.

Registered completion dates are not promises of results announcements. No
company ranking, outcome inference, external timestamp or fresh source
observation follows from reproducing these frozen bytes.
