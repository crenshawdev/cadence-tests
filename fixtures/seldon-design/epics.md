# Toolshed - epics
Built from: spine.md sha256:fce47dade8bb786c

## E-01: Catalog
**Outcome:** Volunteers keep a catalog of tools, and members can search it.
**Boundaries:** Tools and their categories only. No loans and no member records.
**Done when:**
- A volunteer can add a tool with a name, a category and a photo.
- A member can find that tool by name or by category.
- Everything built so far, this epic included, works end to end, with every test passing and nothing half-built showing.
**Depends on:** None
**Requirements:** CAT-01, CAT-02
**Spine decisions:** S-02, S-04, S-05, S-06

## E-02: Lending
**Outcome:** Volunteers check tools out and in at the counter.
**Boundaries:** Members, checkouts and returns. Reminders are not part of it.
**Done when:**
- A checkout records the member, the tool and a due date.
- A return closes the open loan for that tool.
- Member contact details are hidden from anyone who isn't a volunteer.
- Everything built so far, this epic included, works end to end, with every test passing and nothing half-built showing.
**Depends on:** E-01
**Requirements:** LOAN-01, LOAN-02, NFR-01, NFR-02
**Spine decisions:** S-01, S-02, S-03, S-04, S-05, S-06

## E-03: Reminders
**Outcome:** Members are reminded the day before a loan is due.
**Boundaries:** The daily job and its emails. It only reads the loan log.
**Done when:**
- Each loan due tomorrow gets exactly one reminder email.
- Everything built so far, this epic included, works end to end, with every test passing and nothing half-built showing.
**Depends on:** E-02
**Requirements:** LOAN-03
**Spine decisions:** S-01, S-02, S-03, S-04, S-05
