# Toolshed - PRD
Built from: brief.md sha256:c5fe3e61100c2e40

## Requirements

### Catalog
- **CAT-01**: A volunteer adds a tool with a name, a category and a photo. [ASSUMPTION]
- **CAT-02**: A member searches the catalog by name or category.
  > a catalog members can look at from home

### Loans
- **LOAN-01**: A volunteer checks a tool out to a member with a due date.
  > something the volunteers can use at the counter to check tools out
- **LOAN-02**: A volunteer checks a tool back in.
  > check tools out and back in
- **LOAN-03**: A member gets an email reminder the day before a loan is due.
  > a reminder when something's due

## Non-functional requirements
- **NFR-01**: A checkout takes under three seconds on a phone over a slow connection. [ASSUMPTION]
- **NFR-02**: Member emails and addresses are visible only to volunteers. [ASSUMPTION]

## User journeys
A member finds a ladder in the catalog at home, comes to the counter, and a volunteer checks it out for a week. The day before it's due, the member gets a reminder and brings it back, and the volunteer checks it in.

## Non-goals
- It won't charge fees, because the library is free to its members and handling money is work the volunteers don't have time for.
  > it's free for members, and none of us has time to deal with money
- It won't take reservations, because a tool goes to whoever is at the counter, first come first served.
  > no reservations. whoever's standing at the counter gets the tool, first come first served
- It won't let members check tools out themselves, because a volunteer looks each tool over as it goes out and comes back.
  > a volunteer looks over every tool going out and coming back, so no self checkout

## MVP scope
CAT-01, CAT-02, LOAN-01 and LOAN-02. Reminders (LOAN-03) follow once checkouts are in use.
