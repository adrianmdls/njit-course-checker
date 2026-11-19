# Phase 1: Banner synchronization stabilization

Implemented on `feature/scheduled-course-sync`, based on `multi-container`.
`feature/persistent-watchlists` is preserved separately. No experimental refresh
services or snapshot-generation logic have been imported.

## Findings: historical DS / 202710 HTTP 400

The existing local log records a DS / 202710 failure at `express_sync` with HTTP
400. It does not identify the rejected field or retain the submitted snapshot.
The original cause is **unresolved**, and has not been reproduced.

`tests/fixtures/banner-snapshots.json` contains **synthetic**, not captured,
Banner responses. A valid DS 644 response passes the real parser/API pipeline,
including a leading-zero CRN, alphanumeric section label and over-enrollment.
The `conflicting_titles` variant supplies two headings for the same course with
different titles. It passes structural parsing and deterministically produces
HTTP 400 (`title`, row index 1, `conflicting_title`) without database changes.
This demonstrates a plausible validation failure, not the historical cause.

Other plausible failures are malformed course identifiers, non-five-digit CRNs,
blank/oversized titles or section labels, unsupported statuses, negative or
noninteger enrollment, subject mismatches, and conflicting duplicate CRNs.
None is established as an upstream incompatibility, so their validation rules
remain strict. Arrays passed as normalized rows are now explicitly rejected.

Confirmed defects addressed:

- The parser previously skipped course headings lacking their expected table,
  which could silently produce an incomplete snapshot.
- Unexpected envelopes and unrecognized/partial HTML could be misclassified or
  produce uncontrolled errors. BeautifulSoup can repair truncated HTML, so the
  parser checks structural tag pairing, table/heading membership and row shape.
- Both Python callers and Express rejected explicit zero-section snapshots.
- Generic validation errors hid the field responsible for HTTP 400.

## Empty responses and parser contract

A top-level JSON array is required. `[]` is the explicit zero-section contract:
Python submits an empty normalized array and Express returns zero counts while
transactionally recording successful department completion. Existing Courses,
Sections (including IDs and section timestamps), and Watchlists are unchanged.
Rows absent from a nonempty snapshot are also retained.

Nonempty envelopes require string `SECTIONS_TABLE` values, valid course headings,
paired section tables and complete 13-cell data rows. Complete 13-cell `th`
header rows are allowed. Course whitespace is normalized; status is uppercased.
Unsupported rows, extra/unmatched tables or rows, missing tables, truncated tags,
HTML documents, forms and scripts fail the entire response. No records are
submitted from a partially parsed response. Individual CRN lookups use the same
strict parser.

The empty contract is proven by offline fixtures, **not a live observation of
Banner during this phase**. Nonempty envelopes containing empty HTML, header-only
tables or phrases such as `No courses found` are rejected until an authoritative
response shape is available. No new empty-result phrases are guessed.

Banner fetching now disables redirects, requires HTTP 200, retains bounded
connection/read timeouts and emits sanitized request/JSON failures. No upstream
HTTP requests were made during implementation or testing.

## Safe validation diagnostics

The existing POST `/api/internal/sync/department` returns HTTP 400 with:

```json
{"error":"Invalid department snapshot","validation":{"field":"title","row_index":1,"reason":"conflicting_title"}}
```

Indexes are zero-based positions in the submitted `sections` array, before CRN
deduplication. Envelope errors use a null index. The first failure is returned;
the whole request is rejected before acquiring a database connection.
Express logs the same fixed fields with `event: sync_validation_failed`.
No rejected field values, payloads, raw errors, credentials or SQL are logged.
Python accepts only known field/reason combinations and bounded integer indexes;
it discards untrusted extra response fields and retains sanitized diagnostics in
its error message and `.validation` attribute. Authentication, HTTPS, JSON parsing
and body-size failures retain their existing responses.

## Department verification — November 17, 2026

The allowlist is `src/departments.json`: **82 unique sorted NJIT catalog subject
codes**. Machine-readable provenance is in `department-verification.json`.
This is catalog membership verification, not confirmation of Banner availability
or offerings for any term. Phase 1 stores the list for the future scheduler;
it does not add automatic discovery or alter monitoring membership.

Sources checked:

- [NJIT undergraduate course codes](https://catalog.njit.edu/undergraduate/academic-policies-procedures/course-codes/)
- [NJIT graduate course codes](https://catalog.njit.edu/graduate/academic-policies-procedures/course-codes/)
- [NJIT Engineering Technology program](https://catalog.njit.edu/undergraduate/newark-college-engineering/saet-seed/engineering-technology/), explicitly listing ET 101/103
- [NJIT Pharmaceutical Systems Management program](https://catalog.njit.edu/graduate/newark-college-engineering/mechanical-industrial/pharmaceutical-systems-management-ms/), explicitly listing MNE 601

The union of the two official course-code tables contains 80 codes. The ET and
MNE program entries bring the reviewed allowlist to 82. Catalog tables can
include legacy codes and differ from operational schedule selectors.

Compared with the 80-code candidate on preserved commit `599cce9`:

- Added BINF, CIMT, COOP, CPT, HUM, MIP, MIT and TMT, present in NJIT's code tables.
- Retained ET and MNE based on the supplemental NJIT program evidence.
- Excluded GSND and NEUR: [Rutgers NJMS curriculum](https://njms.rutgers.edu/sgs/prospective_students/docs/BMAICurriculum.pdf)
  explicitly lists GSND 5200Q and NEUR 0596Q. Their presence in an NJIT joint
  program does not establish NJIT ownership. These non-R-prefixed exclusions
  demonstrate why a prefix rule is insufficient.
- Omitted INTD, MTH, PHY and PSY pending authoritative NJIT ownership/code
  confirmation. Do not equate these with INT, MATH, PHYS or PHIL automatically.
- [NJIT Biological Sciences](https://catalog.njit.edu/undergraduate/science-liberal-arts/biology/)
  explicitly labels its R120 courses as Rutgers-Newark. They are excluded by
  positive NJIT membership, not by a general string-prefix test.

These discrepancies must be reviewed before claiming complete coverage of all
operational Banner subjects. The registrar links its schedule to Banner; it was
not followed because this phase prohibits live Banner requests.

## Data preservation and tests

Production/development containers and the existing MariaDB volume were not
changed, migrated, restarted or used for test writes. No schema/migration changes
are part of this phase. Existing experimental columns remain unused and intact.
Transactions, advisory locks, Courses/Sections upsert keys and rollback behavior
are unchanged. No delete/replace statements were introduced.

Run offline Python checks:

```sh
.venv/bin/python -B -m unittest discover -s tests -p 'test_*.py'
```

Run Express validation/search tests with `npm test --prefix backend`. Database
cases skip unless `TEST_DB_PORT` points to a **fresh disposable** MariaDB server
with the documented test credentials. Never use an application database. The
sync database test adds compatibility columns to that disposable schema only,
then verifies nonempty/empty upserts leave existing diagnostic values unchanged.
Obsolete generation preservation checks have been replaced by the
[generation cleanup migration regressions](snapshot-generation-cleanup.md). It checks Watchlists, stable IDs, timestamps and rollback of empty
completion failures, alongside the existing upsert/rollback/locking tests.

Run the fixture-only full pipeline:

```sh
python3 -B tests/integration/test_pipeline.py
```

The runner creates its own randomly named stack with tmpfs MariaDB, isolated
networks and no application volume. Its cleanup removes that test project only.
New cases prove valid DS ingestion, safe conflicting-title diagnostics, empty
completion without deleting or altering existing sections/watchlists, and no
writes or freshness changes after malformed/partial responses.

## Phase 2 recommendations

After review, resolve the four unverified codes and confirm operational subject
coverage plus real zero-result/header formats through a separately authorized
small upstream check. Then add the single sequential scheduler, configured terms,
daily full passes, ten-minute watched passes, conservative pacing and one-producer
operation. Keep search database-only. Do not revive the standalone Python
search helper as a competing on-demand producer.

Missing-section deactivation, persistent browser watchlist management,
notifications and schema additions remain separate future work. The parser is
intentionally conservative: newly encountered legitimate formats must get an
explicit offline fixture before support is added. The original DS cause remains
unresolved without its rejected payload; diagnostics will make a future failure
actionable. No scheduling implementation is included in Phase 1.

## Implementation manifest and verification results

| File | Change |
|---|---|
| `src/njit_scraper.py` | Strict complete-response parsing, shared CRN lookup, sanitized HTTP/JSON failures. |
| `src/checker.py` | Permit validated empty submissions; existing polling schedule is unchanged. |
| `src/department_sync.py` | Permit validated empty submissions from the standalone helper. |
| `src/checker_api.py` | Allowlisted structured validation diagnostics. |
| `src/departments.json` (new) | Reviewed 82-code catalog allowlist for future checker use. |
| `backend/src/department-sync.js` | Empty-array acceptance and sanitized field/index/reason diagnostics. Transaction code unchanged. |
| `tests/test_njit_scraper.py` (new) | Parser/fetch hardening and frozen allowlist-evidence checks. |
| `tests/fixtures/banner-snapshots.json` (new) | Synthetic valid, empty, conflicting and malformed Banner fixtures. |
| `tests/test_checker.py` | Empty success and malformed-response rejection. |
| `tests/test_department_sync.py` | Empty helper submission, malformed rejection and safe HTTP 400 diagnostics. |
| `backend/test/department-sync.test.cjs` | Diagnostic contract, empty persistence/rollback and migrated-column compatibility. |
| `tests/integration/checker_probe.py` | Fixture selection for real Python/Express/MariaDB pipeline checks. |
| `tests/integration/test_pipeline.py` | End-to-end empty/malformed/DS conflict preservation tests. |
| `docs/department-verification.json` (new) | Frozen code-only source provenance, exclusions and unresolved codes. |
| `docs/phase-1-sync.md` (new) | Findings, limitations, implementation manifest and test results. |
| `README.md` | Current empty-response semantics and link to Phase 1 notes. |
| `backend/README.md` | Empty-array and validation diagnostic API contract. |

Final results on November 17, 2026:

- Python: 33 passed, no failures or skips.
- Express with fresh disposable MariaDB: 11 passed, no failures or skips.
- Disposable integration pipeline: 13 passed, no failures or skips.
- `git diff --check`: passed.
- Optional browser mode was not run; frontend code did not change.
- The first unprivileged Express run could not bind loopback ports (`EPERM`).
  Rerunning with the required sandbox permission passed. The initial no-database
  Express run skipped two database cases; both passed in the disposable run.
- Disposable database containers/stacks were removed after testing. No files
  were staged or committed; the current and preserved branch refs were retained.
