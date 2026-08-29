---
name: wcag-understandable-forms
description: Judging forms against WCAG 3.2.1 On Focus, 3.2.2 On Input, 3.3.1 Error Identification, 3.3.3 Error Suggestion, 3.3.7 Redundant Entry and 3.3.8 Accessible Authentication Minimum, to load in the ACT lane whenever you drive a form, a login, a checkout or a multi-step flow.
---

# Forms, context changes and error recovery

Six criteria. Four of them - 3.2.1, 3.2.2, 3.3.1 and 3.3.3 - are state-dependent.
They do not exist in a static page. They exist only across a transition, so the
evidence is always a before/after accessibility-tree diff: snapshot, act, snapshot,
diff. A finding citing one tree and no interaction is not a finding.

Lane: ACT. All DECIDE except 3.3.7, which is FLAG.

---

## 3.2.1 On Focus - Level A

### What the standard requires

Receiving focus must not initiate a change of context. A change of context is
exactly four things: a new window or tab opens, focus moves somewhere other than
the control just focused, the form is submitted, or the content of the page is
substantially rearranged.

### How to test it

1. Snapshot the accessibility tree, the URL and the window count.
2. Tab to the next control. Keyboard only, no Enter, no Space, no click -
   activation is a different criterion and is not covered here.
3. Snapshot again and diff those three, plus the focused node path.
4. Repeat for every focusable control, including controls inside dialogs and
   disclosure panels you had to open first.

### Genuine failure

- A `select` that navigates from its `focus` handler, so tabbing into it loads a
  new page before any option is chosen.
- A date field that opens an overlay picker on focus and moves focus into the
  picker grid, away from the field.
- An input whose focus handler submits the enclosing form.
- A control whose focus handler calls `window.open`.
- A field that on focus replaces the contents of `main` with a different step.

### False positive - do not report

- A dialog opened when a button is ACTIVATED. This criterion covers focus, not
  activation, and a button that opens a dialog is the correct pattern.
- A tooltip or hint revealed on focus beside the control. Revealing content is
  not rearranging the page.
- A focus outline, a highlight, or scrolling the control into view.
- A field that reformats its own value on blur.
- Focus moving into a dialog the user opened. 2.4.3 requires that.

---

## 3.2.2 On Input - Level A

### What the standard requires

Changing the setting of a component must not initiate a change of context unless
the user was advised of the behaviour before using the control. Setting means the
value: typing, ticking, choosing a radio, selecting an option.

### How to test it

1. For each `select`, choose a different option. For each checkbox and radio,
   toggle it. For each text field, type a plausible value and blur.
2. After each, diff the same things as 3.2.1: URL, window count, focus location,
   and the landmark and heading structure.
3. Where context did change, look for the warning before ruling: text earlier in
   reading order, in the label, in the `aria-describedby` target, or in
   instructions at the top of the fieldset.
4. Text that appears only after the change does not count as a warning.

### Genuine failure

- A country or language `select` whose `onchange` navigates, with no warning in
  its label or its described-by text. This is the classic failure.
- A form that auto-submits when the last digit of a code is typed.
- A checkbox whose change reloads the page and returns focus to the body.
- A radio group that swaps the visible form for a different one, unwarned.
- A search field that navigates on the third keystroke.

### False positive - do not report

- An on-input context change the user was warned about - "changing this will
  reload the page" in or before the label. That is conformant, however plain the
  wording.
- A filter that updates a results list in place without moving focus and without
  rearranging the rest of the page.
- A `select` whose change is committed only by a separate "Go" button.
- Validation firing on blur. That is 3.3.1, not a context change.
- Autocomplete suggestions appearing beneath a field.

---

## 3.3.1 Error Identification - Level A

### What the standard requires

If an input error is automatically detected, the item in error must be identified
and the error described to the user IN TEXT. Two obligations: the description must
be text, and it must be associated with the field it is about.

### How to test it

Use the FORM TEMPLATE, and do not run the form more than twice.

1. Snapshot the tree. Submit the form empty. Snapshot. Diff.
2. Reset, then submit deliberately wrong formats - letters in a number field, `x`
   in an email field, 31/02 in a date, two characters in a password. Diff again.
3. Read the new nodes in the TREE, not the screenshot. Confirm there is text
   naming the field and text describing what is wrong.
4. Confirm the association: `aria-describedby` from the field to the message, or
   `aria-errormessage` with `aria-invalid="true"`, or the message inside the
   field's own `label`. DOM adjacency alone is not an association.
5. Whether the message was announced is 4.1.3; cross-reference, do not report it.

### Genuine failure

- Fields turn red and nothing else in the tree changes. Colour only.
- An error icon appears beside the field with no text and no accessible name.
- A summary reading "There were 3 problems" that names no field.
- Correct text - "Enter your postcode" - in a `div` with no `aria-describedby`
  from `#postcode` and no `aria-invalid`. The wording is right and the
  association is missing; report it as a failure of association and say so.
- `aria-invalid="true"` with no error text anywhere on the page.

### False positive - do not report

- A client-side validation message appearing on blur, in text, correctly
  associated. That is a pass. Validation timing is not a criterion.
- An error summary at the top that names every field AND per-field messages as
  well. That duplication is the recommended pattern.
- Colour used in ADDITION to associated text.
- A required field the user has not touched yet. No error has been detected.
- A missing label or format instruction before submission. That is 3.3.2.

---

## 3.3.3 Error Suggestion - Level AA

### What the standard requires

When an input error is detected and a correction is known, the correction must be
suggested, unless doing so would jeopardise the security or purpose of the
content. Saying the field is wrong is 3.3.1; saying how to make it right is 3.3.3.

### How to test it

1. Reuse the wrong-format submissions you already made for 3.3.1.
2. For each message ask: could a person act on this without guessing? The
   suggestion may be the expected format, an example, an allowed range, the list
   of valid options, or a "did you mean" correction.
3. For a constrained field - date, postcode, telephone, card number, password -
   confirm the rule is stated in text.
4. For authentication, check whether the suggestion would leak. "No account with
   that email" is a genuine security exception; note it, do not report it.

### Genuine failure

- "Invalid input", "This field is invalid", "Error", "Please check your entry".
- A date field rejecting `13/06/2026` with "Invalid date" and never stating that
  it expects MM/DD/YYYY.
- A password field that rejects without stating the rule it broke - the minimum
  length, the character classes, the banned string.
- A card field saying "Card number not accepted" where the real rule is that the
  issuer is unsupported.
- A postcode field with a regex behind it whose message gives neither the pattern
  nor an example.

### False positive - do not report

- "Enter the date as DD/MM/YYYY". "Password must be at least 12 characters".
  Those are suggestions; they pass.
- A login form saying "Your email or password was not recognised" without naming
  which. That is the explicit security exception.
- A terse suggestion. Tone is not a criterion.
- An empty required field answered with "Enter your full name". Naming what to
  enter IS the correction.
- "That username is taken, choose another". Do not demand a generated alternative
  where no correction is knowable.

---

## 3.3.7 Redundant Entry - Level A

### What the standard requires

Information previously entered by, or provided to, the user in the same process
must be auto-populated or available for the user to select. Three exceptions:
re-entry is essential, the information is required for security, or the earlier
information is no longer valid.

### How to test it

1. Identify the process - a sequence of steps towards one goal with a defined
   end. A checkout, a registration, an application, a booking.
2. Complete step one with distinct, recognisable values.
3. Advance to step two and read the tree. Anything step one collected must be
   pre-filled or offered for selection ("same as billing address").
4. Continue to the end, and include the state after a validation failure. A form
   that empties itself on error is re-asking.
5. Record the step URLs and the field labels on both sides.

### Genuine failure

- A checkout collecting the delivery address at step 2 and the same address at
  step 4 with no "same as" control.
- A registration that discards every field when the password fails validation.
- A booking flow re-asking the passenger date of birth on the payment step.
- An email collected at step 1 and asked for again, empty, at step 3.

### False positive - do not report

- A password confirmation field. Explicit exception - re-entry is essential.
- A field re-asked for security: a card CVV, a password confirmed before an
  email change.
- Two unrelated processes. A footer newsletter sign-up is not part of a checkout.
- Information the user could reasonably need to change - a delivery date asked
  again after the earlier slot expired.
- A later step offering the earlier answer for selection rather than pre-filling
  it. Selection satisfies the criterion.

---

## 3.3.8 Accessible Authentication (Minimum) - Level AA

### What the standard requires

No step of an authentication process may rely on a cognitive function test -
remembering a password, solving a puzzle, transcribing characters, performing a
calculation - unless one of these holds: an alternative method exists that does
not rely on such a test; a mechanism is available to assist the user in
completing it; the test is object recognition; or the test is identifying
non-text content the user themselves provided to the site.

### How to test it

1. Find every authentication surface: sign-in, sign-up, password reset,
   one-time-code entry, and any step-up check.
2. Attempt to paste into every password and code field, and look for an `onpaste`
   handler calling `preventDefault` and for `autocomplete="off"`. Blocking paste
   removes the password-manager assist and turns the field into a memory test.
3. Read the `autocomplete` tokens: `username`, `current-password` on sign-in,
   `new-password` on sign-up, `one-time-code` on a code field. A missing or wrong
   token breaks the assisting mechanism.
4. Find any CAPTCHA and classify it. Transcribing distorted characters or solving
   arithmetic is a cognitive function test and fails; identifying objects in
   images is object recognition and is exempt at this level.
5. Look for an alternative route past whatever test you found - a passkey, a
   magic link, WebAuthn, a device-based path.

### Genuine failure

- A password field with `onpaste` returning false, or `autocomplete="off"`, and
  no passkey or magic-link alternative.
- A six-box one-time-code widget where pasting fills only the first box, so the
  user must transcribe six digits one at a time.
- A distorted-character CAPTCHA as the only route through sign-in.
- An arithmetic puzzle - "what is 7 plus 4" - gating the login form.
- A memorised security question, "the name of your first school", required with
  no alternative.

### False positive - do not report

- An image CAPTCHA asking the user to select all the buses or traffic lights.
  Object recognition is exempt at Minimum. It is still worth one `minor` FLAG
  recording the barrier, and `detail` must say plainly that it is exempt here and
  is not a conformance failure.
- A password field that permits paste and carries the right token. The password
  is still memorised; the assisting mechanism is what the criterion requires.
- A one-time code sent by email or SMS where the field accepts a pasted value and
  carries `autocomplete="one-time-code"`.
- Biometric or device unlock, and passkeys generally.
- A rate-limit or lockout message. Not a cognitive function test.

---

## Reporting rules for this group

- One finding per element per criterion. A `select` that navigates on focus AND
  on change is two findings, 3.2.1 and 3.2.2. A field whose error message is
  unassociated and also says nothing about how to fix it is two findings, 3.3.1
  and 3.3.3.
- Severity is about the user's task. No error text at all on a login or checkout
  the user therefore cannot complete is `critical`. An unwarned context change
  that discards entered data is `critical`; one that reorders a filter panel is
  `moderate`. A blocked paste on the only sign-in route is `critical`. A missing
  format hint on an optional field is `minor`.
- Evidence discipline. Every state-dependent finding names the interaction,
  quotes the before value and the after value, and cites the selector. "The
  `select#country` on /apply navigates to /apply?c=FR on `change`, with no
  warning in its label or its `aria-describedby` target" is a finding. "Selects
  sometimes navigate" is not. Never invent a selector; where you have none, leave
  it null and identify the control by its accessible name and its position.
- Write tree dumps, traces and screenshots to the sandbox filesystem and
  reference them by path in `detail`. Do not paste artifacts into the reply.
- Verdict policy. 3.2.1, 3.2.2, 3.3.1, 3.3.3 and 3.3.8 are DECIDE - you drove the
  transition and you hold both trees, so rule. 3.3.7 is FLAG on every finding,
  however clear it looks, because whether re-entry is essential is a business
  judgement. Use BLOCKED when you could not submit the form at all - a live
  payment gateway, a required real account - and say which in `detail`.
