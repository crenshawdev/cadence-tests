# Toolshed - architecture spine
Built from: prd.md sha256:7a20fa823f74a80d

## S-01: Loans are an append-only event log
Kind: how state changes
Checkouts and returns are stored as events and never edited. Who has a tool, and whether it's overdue, is computed from the log.
> nobody knows who has what or when it's due

## S-02: One server-rendered web app
Kind: design approach
The counter screens and the public catalog are pages of one app. There's no separate API.
> something the volunteers can use at the counter to check tools out and back in, plus a catalog members can look at from home

## S-03: Reminders run from a daily scheduled job
Kind: boundaries
A job runs once a day, reads the loan log and sends that day's reminders. Nothing sends email while a request is being handled.
> a reminder when something's due

When a run fails, the counter screen shows the volunteers a notice naming the reminders that didn't go out, until a volunteer dismisses it. [ASSUMPTION]

## S-04: Node with one SQLite database
Kind: stack
The app runs on Node and keeps the catalog, the members and the loan log in one SQLite database file. [ASSUMPTION]

## S-05: One small rented server
Kind: hosting
The app and its database file run on one small rented virtual server. [ASSUMPTION]

## S-06: Members reach only the catalog
Kind: boundaries
The catalog pages are the only part members and the public reach from outside, and what they type there is only ever read as search text. Member emails and addresses sit behind the volunteer login, and no catalog page shows them. [ASSUMPTION]
