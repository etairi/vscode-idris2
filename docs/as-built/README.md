# As-built records

The plan lives in `docs/ROADMAP.md` (what each milestone delivers, and why) and
`docs/ARCHITECTURE.md` (the design it is built to). The files here record what was built: for
each finished milestone, where the implementation reads or departs from its text in ROADMAP §5
and from the design, the measurements and experiments behind that, and the review, verification
and gate runs that checked it. Every finished milestone in ROADMAP §5 has a short **Status**
entry pointing here.

| File | Milestone | Done | Commits | Green CI run |
|---|---|---|---|---|
| [`M0.md`](M0.md) | Language foundation and engineering harness | 2026-09-27 | `90ce347`, `eb29a8f`, `0cb58b0` | 36327566094 (ubuntu, macOS, Windows) |
| [`M1.md`](M1.md) | Toolchain and project discovery | 2026-09-27 | `8de65af`, `3643ba7`, `6334a30` | 36349376366 (ubuntu, macOS, Windows) |
| [`M2.md`](M2.md) | IDE-mode core: transport, session, diagnostics | 2026-09-28 | `09a3809`, `2486530` | 36483316082 (ubuntu, macOS) |
| [`M3.md`](M3.md) | Read-only intelligence over IDE mode | 2026-09-29 | `04e96aa`, `263f38f` | 36674477234 (ubuntu, macOS; on `04e96aa`) |
| [`M4.md`](M4.md) | Interactive editing and holes (IDE mode) | 2026-09-30 (integrated) | not committed yet | — |

## How these files were made

On 2026-09-28 the following text was moved here **verbatim** (only headings and a one-line
introduction per section were added; wording, evidence tags and dates are unchanged):

- the "As built" record of ROADMAP §5 M0, M1 and M2, with one `###` heading per entry, named
  after the entry's italic label (*Processes*, *Consent*, …);
- the "As built" paragraphs of ARCHITECTURE, under the heading of the section they came from:
  §11 and §12 for M1 (in `M1.md`); §5.1, §5.2, §6.1, §6.2, §8, §11 and §12 for M2 (in `M2.md`);
- from ROADMAP §9, the E6 measurements (`M0.md`) and the questions Q20, Q21 and Q22 as they were
  put to the user (`M2.md`; the decisions stay in ROADMAP §9);
- the development log that `CHANGELOG.md` held, entry by entry, in the file of its milestone
  (the changelog itself now says what a user gets).

What the documents they came from still say about these parts: ROADMAP §5 a Status entry per
milestone; ARCHITECTURE a short "As built" paragraph per section naming what the record covers.
A script (not kept in the repository) checked the move against the documents at `2486530`:
every moved block occurs verbatim here (69 pieces, the ROADMAP records entry by entry), and of
the 2,577 sentences, table cells and code lines of the old ROADMAP, ARCHITECTURE and CHANGELOG,
all but 43 occur unchanged in the new documents; those 43 were rewritten on purpose —
references pointed at the new location, the M3 text and the `eval` session's description
changed by the user's decisions of 2026-09-28 (ROADMAP §9), three lines of ARCHITECTURE's
layout tree re-wrapped, and the changelog heading "Changed", now "Removed" (after the
verification of the move, the "Removed" section gave way to a platform note in the changelog's
introduction, since native Windows support had never been released).

## Reading the moved text

The text keeps the references it had where it was written:

- **"the text above"** in a ROADMAP record means that milestone's text in ROADMAP §5; **"above"**
  or **"the paragraph above"** in an ARCHITECTURE note means the design text of that section of
  ARCHITECTURE.
- **`§n`** means a section of the document the text came from — ROADMAP for the records and the
  §9 entries, ARCHITECTURE for the ARCHITECTURE notes — unless the text names another document.
- **"As built, *X*"**, **"M2 As built, *X*"**, **"ROADMAP M1 As built, *X*"**, **"M1 *X*"** and
  **"ROADMAP Mn "As built""** mean the entry *X* of `Mn.md` (the same milestone when none is
  named).
- **"ARCHITECTURE §n as built"**, and **"§n as built"** inside an ARCHITECTURE note or an M2
  entry, mean the heading *ARCHITECTURE §n* of `M2.md` (§6: §6.1 and §6.2); the ARCHITECTURE
  notes of M1 are only §11 and §12, and every reference names them with M1.
- Evidence tags are those of ROADMAP's legend: **[live]** run on the development machine,
  **[src]** read in the named source, **[doc]** from a README or specification, **[gh]** a GitHub
  issue, **[open]** not verified.

References from other files use the form `docs/as-built/M2.md`, *Entry* (or *ARCHITECTURE §5.1*
for an ARCHITECTURE note).

## Adding a milestone

When a milestone is done, its as-built record goes into a new `docs/as-built/Mn.md` (not into
ROADMAP or ARCHITECTURE), and its ROADMAP §5 entry gets a Status entry: done, date, commits, CI
run, and the link here.
