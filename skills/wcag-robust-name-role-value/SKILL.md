---
name: wcag-robust-name-role-value
description: Judging WCAG 4.1.2 Name, Role, Value and 4.1.3 Status Messages by diffing the accessibility tree across an interaction, to load in the ACT lane whenever a control toggles, expands, selects, checks, or produces a message.
---

# Name, role, value and status messages

This is the highest-yield check in the whole product. The toggle template -
snapshot, click, snapshot, diff - finds controls that lie about their state: the
disclosure that never updates `aria-expanded`, the tab that never moves
`aria-selected`, the switch whose `aria-checked` is frozen. No rule engine can
find those, because in a single static snapshot the markup looks correct. Only the
transition exposes the lie.

Lane: ACT. Both criteria are DECIDE. Both are state-dependent: a finding citing
one tree and no interaction is not a state finding.

---

## 4.1.2 Name, Role, Value - Level A

### What the standard requires

For every user-interface component the name and the role must be programmatically
determinable; states, properties and values the user can set must be
programmatically determinable; and notification of changes to those items must be
available to user agents including assistive technology.

Break that into four tests and run them in this order.

| Test | Question |
|---|---|
| (a) Role | Does it have a role that matches what it looks like and what it does? |
| (b) Name | Does it have an accessible name, and does the name say what it does? |
| (c) State | Does it expose the state it visibly has right now? |
| (d) Change | Does the exposed state CHANGE when the visual state changes? |

Tests (a) to (c) are readable from one snapshot and TREE already catches most of
them. Test (d) needs two snapshots and is where the real findings are.

State attributes to watch: `aria-expanded`, `aria-checked`, `aria-selected`,
`aria-pressed`, `aria-current`, `aria-disabled` and the native `disabled`
property, `aria-valuenow` with its min, max and `aria-valuetext`, `aria-invalid`,
and the `open` property on `details` and `dialog`.

### How to test it

THE TOGGLE TEMPLATE, exactly:

1. Capture the full accessibility tree. Record the target's role, its accessible
   name, and every state attribute it carries. Save the dump to the sandbox and
   note the path. Screenshot the starting visual state.
2. Activate the control once the way a user would - click, or Enter or Space with
   focus on it. Depth is one; do not chain interactions.
3. Wait for the visual change to settle, then capture the tree and the screenshot
   again. Save both.
4. Diff the two trees. Three outcomes:
   - The tree changed somewhere AND the control's own state attribute changed.
     Pass.
   - The tree changed somewhere and the control's state attribute did NOT change.
     4.1.2 finding: the control is lying about its state.
   - Nothing in the tree changed while the screenshots differ. The change is
     CSS-only and invisible to assistive technology. Also a 4.1.2 finding, and the
     strongest one you can produce - the screenshots are the evidence.
5. While you hold the first snapshot, run tests (a) to (c) over every node that
   looks interactive, comparing what the picture says the control is against what
   the tree says its role is.

### Genuine failure

- A `div` with an `onclick` handler and no `role`, reported by the tree as generic
  text. It looks like a button and announces as nothing.
- A disclosure `button` whose panel opens and closes while `aria-expanded` is
  absent, or is hard-coded `"false"` in both snapshots.
- A custom tab set where the active tab is restyled but `aria-selected="true"`
  never moves off the first tab.
- A `div` with `role="switch"` and no `aria-checked` in either snapshot, or a
  `role="checkbox"` whose `aria-checked` stays `"false"` after the tick appears.
- A "Save" icon button whose only content is an inline `svg` with no `title` and
  no `aria-label` on the button. No accessible name at all.
- A `role="slider"` handle with no `aria-valuenow`, or an `aria-valuenow` frozen
  at its initial value while the thumb moves.
- A control greyed out with `pointer-events: none` and neither `disabled` nor
  `aria-disabled`.
- A menu button whose menu opens while `aria-expanded` sits on the wrapper `div`
  rather than on the button, so the button itself exposes nothing.

### False positive - do not report

- A native `button`, `input`, `select`, `textarea`, `a[href]`, or a
  `details`/`summary` pair with visible text. The platform supplies role and name.
  Never report "missing role" on a native control and never ask for
  `role="button"` on a `button`.
- `aria-label` duplicating the visible text. Redundant, not a failure. It becomes
  a failure only when the accessible name contradicts or omits the visible label,
  and that is 2.5.3 Label in Name, not 4.1.2.
- A decorative element with `aria-hidden="true"` and no accessible name.
- A `details`/`summary` disclosure. The `open` property is the state and the
  browser maintains it. Do not demand `aria-expanded` as well.
- `aria-expanded` on the control while the panel carries no ARIA. The state
  belongs on the control, not on the region it controls.
- A different state attribute from the one you expected. A set of links using
  `aria-current` rather than `aria-selected` is a legitimate pattern.
- A control whose state did not change because the interaction genuinely did
  nothing - a disabled button, a link to the current page. Say the interaction was
  inert; do not invent a state failure out of it.

---

## 4.1.3 Status Messages - Level AA

### What the standard requires

A status message is content that informs the user of a change, the result of an
action, the state of an application, the progress of a process, or the existence
of an error - and that does not receive focus. It must be programmatically
determinable through role or properties, so assistive technology can announce it
WITHOUT the user moving focus to it. Two separate obligations: exposed as a
status, and announced without stealing focus.

Containers that satisfy it: `role="status"`, `role="alert"`, `role="log"`,
`role="progressbar"`, `role="marquee"`, `role="timer"`, or any element carrying
`aria-live="polite"` or `aria-live="assertive"`.

### How to test it

THE LIVE-REGION TIMING RULE. A live region announces only text inserted into a
container the assistive technology was already observing. If the container and its
text enter the DOM together, most screen readers announce nothing. This is a real
failure, it is very common, and it is the usual reason a correctly-roled message
stays silent. The check is therefore about ORDER, and order is only visible across
two snapshots.

1. Snapshot the tree BEFORE the action. Search it for every container in the list
   above and record each one, its role, and whether it is empty. This pre-existing
   inventory is what your verdict turns on.
2. Perform the action that produces the message: submit the form, delete the row,
   start the upload, apply the filter.
3. Wait 100 to 500 ms, then snapshot again. Long enough for the message to render
   and any transition to settle, short enough that a toast has not auto-dismissed.
   Snapshot at the low end first and repeat at the high end if you saw nothing.
4. Diff. The message text must now sit INSIDE a container present in snapshot 1.
   If the container appears for the first time in snapshot 2 already carrying its
   text, it will not be announced - that is the finding, and `detail` must say the
   container was absent from the first tree.
5. Confirm focus did not move. Compare the focused node before and after.
6. For progress, check `role="progressbar"` and that `aria-valuenow` advanced, or
   that a live region's text changed.
7. Match politeness to the message. Errors take `role="alert"` or
   `aria-live="assertive"`; confirmations, counts and progress take
   `role="status"` or `aria-live="polite"`. An assertive region used for a routine
   confirmation interrupts the user and is worth a `minor` finding.

### Genuine failure

- A toast created and inserted with `role="status"` already carrying its text.
  Container and content arrive together and nothing is announced.
- "3 items added to your basket" appearing in a plain `div` with no role and no
  `aria-live`.
- A search results count that updates silently while the user stays in the field.
- Validation errors written into a summary `div` with no `role="alert"`, no live
  region, and no focus moved to it. The user gets no signal at all.
- An upload progress bar drawn as a styled `div` with no `role="progressbar"` and
  no live text alongside it.
- A "Saving" then "Saved" indicator whose text changes inside a container with no
  live role.
- A toast that calls `.focus()` on itself and pulls focus out of the field the
  user was typing in.

### False positive - do not report

- `role="alert"` firing on page load. Noisy, worth a note at most; it is not a
  4.1.3 failure.
- A toast that is merely focusABLE - `tabindex="-1"`, or a close button in the tab
  order - but did not take focus. It fails only if focus was stolen.
- Content the user is deliberately taken to, such as a dialog opened in response
  to their own action. Content that receives focus is not a status message.
- An empty live region sitting in the page doing nothing. That is the correct
  pattern, not dead markup.
- Both `role="status"` and `aria-live="polite"` on one element. Redundant, harmless.
- A native `output` element. It carries an implicit `role="status"`.
- A message inserted into a region that was already present and empty. A pass; it
  is the whole point of the pattern.
- A page load or route change. Navigation is not a status message.

---

## Reporting rules for this group

- One finding per element per criterion. A control with no accessible name that
  also never updates `aria-expanded` is ONE 4.1.2 finding listing both defects. A
  control that fails 4.1.2 and also produces an unannounced message is two
  findings, one per criterion.
- Severity is about the user's task. A control that lies about its state on the
  primary path - the menu button on every page, the checkbox that gates
  submission - is `critical`. The same lie on a decorative footer accordion is
  `minor`. An unannounced error that blocks a submission is `critical`; an
  unannounced "copied to clipboard" toast is `minor`.
- Evidence discipline. Every finding here cites two snapshots. Quote the state
  attribute and its value on both sides - `aria-expanded="false"` before,
  `aria-expanded="false"` after, panel visible in the second screenshot - and
  reference the saved tree dumps by sandbox path. A 4.1.2 claim resting on one
  snapshot is not a state finding and will read as a duplicate of the rule engine.
  Never invent a selector; where you have none, leave it null and identify the
  control by its accessible name, its role and its position.
- Do not duplicate TREE. Missing names and roles on static markup are already
  reported. Your value is test (d) and the live-region timing rule; lead with them.
- Verdict policy. Both criteria are DECIDE: you drove the transition and you hold
  both trees, so rule. Use FLAG only where the correct role is genuinely a design
  judgement rather than a fact. Use BLOCKED when you could not reach the control
  or could not make the message appear - a paywall, a required login, a
  third-party widget inside a cross-origin frame you cannot read - and say which
  in `detail`.
