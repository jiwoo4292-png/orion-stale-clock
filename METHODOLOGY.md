# Stale Clock methodology

Policy: `stale-clock-v5-20260929-3`. This is a current observed registry snapshot
evaluated using an explicitly chosen reference date, not historical as-of data.

The frozen observation completed `2026-09-29T09:46:12.309Z`. The reference date
for all four metrics is `2026-08-31`; the twelve-calendar-month cutoff for B/C is
`2025-08-31`. **All four metrics use interval end <= reference date; B and C use
this inclusive comparison at their specified twelve-month cutoff.**

## Population and metrics

The frozen population contains 3,762 global industry-led active trials containing
PHASE3, including combined Phase 2/3. Active statuses are RECRUITING,
ACTIVE_NOT_RECRUITING, NOT_YET_RECRUITING and ENROLLING_BY_INVITATION. This is a
reference population, not ORION's selected monitoring coverage.

| Metric | Definition | Frozen numerator / denominator |
| --- | --- | --- |
| A | ESTIMATED primary completion interval ends on or before reference | 377 / 3,762 |
| B | A rows whose last-update posted interval ends on or before 2025-08-31 | 226 / 377 |
| C | A rows whose primary completion interval ends on or before 2025-08-31 | 82 / 377 |
| D | NOT_YET_RECRUITING, ESTIMATED start interval ends on or before reference | 331 / 552 |

Missing or unsupported date/basis values remain UNAVAILABLE. They are reported
in date-quality counts, not invented as zero or removed from denominators.
A month-precision date is the entire calendar month. YEAR precision does not
qualify. A MONTH record qualifies only when its interval's last day is on or
before the applicable cutoff. Calendar subtraction clamps leap days.

## Wall

A contains 224 DAY and 153 MONTH records. Only DAY records contribute elapsed
days at the shared reference date: total 54,361 days, divided by 365.25 and
rounded to one decimal = 148.8 combined years; median 153 days; longest 2,650.
MONTH records are excluded from these elapsed-day statistics. Boundary DAY rows
at the reference date contribute zero days. Clocks are ordered by NCT ID, not
company performance. None of these measures establishes a trial delay.

## Reproduction and fresh queries

Offline replay uses the exact allowlisted 3,762-record snapshot to recompute
metrics from registered dates, basis and status; stored metric flags are not
evidence on their own. The CSV contains exactly A's 377 records in NCT order.
Check `data.csv.sha256` and `provenance.json` before reusing it.

Live collection uses only official `/api/v2/studies` and `/api/v2/version`.
Condition and sponsor filters are registry search filters. Lead sponsor names
are not automatically verified corporate parents or ticker mappings. A combined
Phase 2/3 trial qualifies for PHASE3; phase labels remain explicit.

Pagination must finish, advertised totals must match unique IDs, all source
filters must hold and source version must remain stable. Errors do not produce
a successful complete report. API query replay today may differ from the frozen
release because the official API supplies the current record, not all historical
versions. Derived output is local; nothing is posted, emailed or scheduled.

Every live retrieval records its actual observation time. Supplying an old
reference date never backdates observation. A hash checks byte integrity, not
source truth, completeness or first discovery. No daily seal or OpenTimestamps
receipt is included in this release.

## Next checks

The next frozen-377 recheck is planned for 26 October 2026. It asks whether each
record's last-update posted value is newer than baseline. A bulk registry update
must be separately noted. The next monthly edition is planned for early November
with a 31 October reference. Neither date is an already measured result.
