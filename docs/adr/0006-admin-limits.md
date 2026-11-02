# ADR-0006 · Admins can't edit karma or override community notes

**Status:** accepted · 2026-11-03

## Context

The admin console (`/admin`) gives a few people broad power: sanctions, roles, settings, content. Two kinds of edit would undermine the product even when well-meant:

- **Editing karma or XP directly.** Karma is a cached sum of an append-only ledger (ADR-0002). A hand-edited number has no cause anyone can check, and members would rightly stop trusting it.
- **Overriding a community note's status.** Notes carry weight because raters who usually disagree agreed on them. A note that staff could force to Helpful or Not helpful becomes the platform's opinion. X makes the same choice: its own teams can't edit or override Community Notes.

## Decision

- There is no RPC that sets karma, XP, tier or a note's status. Penalties are undone by reversing their cause: restoring content (`admin_restore_content`) and upholding appeals both reconcile the original ledger event to zero, and a strike given by mistake can be removed (`admin_revoke_strike`). Every reversal is itself a ledger row and a log entry.
- An admin may **hide** a note that breaks the rules itself (`admin_set_note_hidden`). Hiding never chooses a status. An open note is closed as Needs More Ratings, which pays nobody and strikes nobody. A settled note keeps its settlement, and only disappears from view.
- Every admin write requires a reason, is rate-limited and is logged with the admin's identity. Nobody changes their own role, and the last admin can't be removed.

## Consequences

- Fixing a mistake can take one more step: restore the content, rather than "give the karma back". The audit trail stays complete.
- A rule-breaking note that settled Helpful keeps its writer reward. That reward is moderation XP only (private), and the writer can be sanctioned separately.
- The console can never be the reason a note reads as the platform's opinion.
