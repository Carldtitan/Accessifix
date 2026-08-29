---
name: wcag-operable-control
description: Giving control back to the user under WCAG 1.4.2 Audio Control, 2.1.2 No Keyboard Trap, 2.1.4 Character Key Shortcuts, 2.2.1 Timing Adjustable, 2.2.2 Pause Stop Hide and 2.4.1 Bypass Blocks. Load when auditing autoplaying sound, keyboard traps, single-key shortcuts, session timeouts, carousels and other moving content, or skip links.
---

# Taking control - escaping, pausing, silencing and skipping

Six criteria that look unrelated and are not. Every one is about the user
taking control back from the page: stop the sound, escape the trap, disable the
shortcut, extend the time, pause the motion, skip the repeated blocks. The page
started something the user did not ask for, and the question each time is
whether the way out can actually be reached by keyboard.

Lane: ACT. You need the browser for all six. 2.1.2 is state-dependent - a trap
is only found by walking the sequence.

| Criterion | Verdict | Why |
|---|---|---|
| 1.4.2 Audio Control | DECIDE | Sound plays or it does not; a control exists or it does not. |
| 2.1.2 No Keyboard Trap | DECIDE | Tabbing forward and back settles it. |
| 2.1.4 Character Key Shortcuts | FLAG | Whether a shortcut is a real barrier is a human call. |
| 2.2.1 Timing Adjustable | FLAG | Whether a limit is essential is a human call. |
| 2.2.2 Pause Stop Hide | DECIDE | Duration, parallelism and the control are observable. |
| 2.4.1 Bypass Blocks | DECIDE | Either a bypass mechanism moves focus or it does not. |

---

## 1.4.2 Audio Control - Level A

### What the standard requires

Audio that plays automatically for more than 3 seconds needs a mechanism to
pause or stop it, or to control its volume independently of the system volume.
The mechanism must be near the start of the page, keyboard reachable, and
carry an accessible name that says what it does.

### How to test it

1. Load with a fresh context and audio enabled. Enumerate `audio` and `video`
   elements and any Web Audio context, reading `paused`, `muted`, `volume` and
   `currentTime` at 1s and again at 4s after load.
2. If something is still playing unmuted at 4s, the criterion is engaged.
3. Tab from the top and record how many stops it takes to reach a pause, stop
   or mute control for that sound. Activate it and re-read `paused` or `volume`
   to confirm it works.
4. Check independence: a page-level volume control counts, an instruction to
   turn down the operating system counts for nothing.

### Genuine failure

- `audio autoplay loop` background music with no control anywhere in the DOM.
- A hero `video autoplay` with sound whose only mute affordance is a `div` with
  a click handler and no keyboard route.
- An audio advert starting on load whose stop button sits fifty tab stops in.
- A Web Audio ambience started in a `load` handler with no user-facing control.
- Sound that can only be stopped by muting the browser tab or the machine.

### False positive - do not report

- Audio that plays only after the user activated something.
- Audio that stops by itself inside 3 seconds - a click, a chime, a chord.
- `video autoplay muted playsinline` background loops. Muted is not audio.
- A player with native `controls` that autoplays. The native control set is the
  mechanism.

---

## 2.1.2 No Keyboard Trap - Level A

### What the standard requires

If focus can be moved to a component, focus can be moved away from it using
Tab, Shift+Tab, or documented standard exit keys. Where the exit is anything
other than Tab or an arrow key, the user must be told how to get out.

### How to test it

1. Tab forward from `body` through the whole document, recording the focused
   element at every stop. Then Shift+Tab all the way back. Both directions
   matter: traps that only bite backwards are common in embedded widgets.
2. Record the two failure signatures: focus that stops advancing (the same
   element at consecutive stops), and focus that cycles forever inside one
   subtree that is not a modal dialog.
3. Cap the walk at twice the number of focusable elements. Hitting the cap
   without leaving a subtree is the evidence for a cycle.
4. Where focus sticks inside an embedded surface - an `iframe` player, a rich
   text or code editor, a map - try the documented exit keys and check whether
   the page documents them anywhere the user would find them.
5. For every modal, confirm an exit exists before calling it a trap.

### Genuine failure

- A rich text editor where Tab inserts a tab character and no documented key
  moves focus out, so the user is stuck for the rest of the session.
- A third-party `iframe` widget focus enters and never leaves in either
  direction.
- A custom modal with a focus loop, no Escape handler and no close control in
  the cycle.
- A date picker that captures Tab inside the calendar grid with no way back.
- An infinite-scroll list that re-focuses the newest item on every advance.

### False positive - do not report

- A modal dialog that traps focus deliberately and exits on Escape or through a
  visible close control. That is the required pattern, not a trap.
- A composite widget with roving `tabindex` where Tab leaves and arrows move
  within.
- A component needing a documented non-Tab exit key that the page documents on
  screen.
- A page you did not walk in both directions. Shift+Tab is half the test.

---

## 2.1.4 Character Key Shortcuts - Level A

### What the standard requires

A shortcut implemented with only letter, punctuation, number or symbol
characters must be turn-off-able, remappable to include a non-printable key
such as Ctrl or Alt, or active only while the relevant component has focus.

### How to test it

1. Enumerate `keydown`, `keypress` and `keyup` listeners bound at `document`,
   `window` or `body` level. The signature is a handler branching on bare
   `e.key` values with no `e.ctrlKey`, `e.altKey` or `e.metaKey` test.
2. Probe empirically. With focus on `body`, press `/`, `s`, `?`, `j`, `k`, `g`,
   `n`, `c` and `.` one at a time, snapshotting the tree after each. Any state
   change is a live single-character shortcut.
3. Put focus in a text input and press the same keys again. A shortcut that
   fires while a field has focus is the failing case - speech input and
   dictation will trigger it by accident.
4. Look for the escape hatches: a settings toggle, a remapping screen, or
   scoping so the listener only runs while one component holds focus.

### Genuine failure

- A global `keydown` mapping `/` to focus search that fires while the user is
  typing in a comment box.
- Single-letter actions (`e` archive, `#` delete) with no toggle and no
  modifier.
- A media player binding bare `k`, `j` and `l` at document level rather than
  while the player has focus.
- A shortcut layer guarded by `e.target.tagName !== 'INPUT'` that ignores
  `textarea` and `[contenteditable]`.

### False positive - do not report

- Shortcuts that include a modifier, such as Ctrl+S or Alt+Shift+N.
- Shortcuts active only while a component has focus - arrows in a listbox or
  grid, Space on a focused button.
- Browser behaviour: typeahead in a `select`, Space to scroll the document.
- A shortcut with a working disable toggle, however buried the setting is.
- A shortcut you read about in a help panel but never observed firing.

---

## 2.2.1 Timing Adjustable - Level A

### What the standard requires

For each time limit the content sets, one must hold: the user can turn it off
before meeting it, can adjust it to at least ten times the default before
meeting it, or is warned at least 20 seconds before expiry and can extend it
with a simple action at least ten times. Exceptions: real-time events, limits
that are essential so that extending them invalidates the activity, and limits
longer than 20 hours.

### How to test it

1. Find the limits: session timeout warnings, basket or seat reservations,
   one-time-code entry windows, quiz timers, auto-advancing wizards, visible
   countdowns.
2. Note the announced duration, start a wall clock, and do not interact.
3. At expiry record whether a warning arrived at least 20 seconds earlier,
   whether it was in text rather than only a colour change, whether it
   announced itself or took focus, and whether work in progress was destroyed.
4. Confirm the extend control is keyboard reachable and that activating it
   actually restores the full period. Look for a setting that turns the limit
   off or lengthens it before it is met, not after.
5. Classify against the exceptions before writing: real-time, essential, or
   over 20 hours.

### Genuine failure

- A session expiring after 15 minutes into a login screen, with no warning and
  no saved form data.
- A five-minute basket reservation with a countdown and no extend control.
- A one-time-code field that clears itself after 30 seconds with no way to ask
  for more time.
- A "you will be logged out in 10 seconds" dialog. The warning is real and the
  20-second minimum is not met.

### False positive - do not report

- A live auction close, a live stream, a scheduled broadcast. Real-time events
  are exempt.
- An exam or timed assessment where the limit is the point of the activity.
- A limit longer than 20 hours, such as a 30-day authentication token.
- A security session that warns in good time and extends on one button press.
- An animation duration or a debounce interval. Neither limits the user's
  ability to act.

---

## 2.2.2 Pause, Stop, Hide - Level A

### What the standard requires

Moving, blinking or scrolling content that starts automatically, lasts more
than 5 seconds and is presented in parallel with other content must be
pausable, stoppable or hideable. Auto-updating content that starts
automatically and runs in parallel with other content needs the same, or a way
to control the update frequency.

### How to test it

1. Inventory the moving things: carousels, marquees, animated backgrounds and
   video loops, news and price tickers, endless skeletons, auto-refreshing
   feeds, live scoreboards, count-up statistics, anything driven by a
   `setInterval` that mutates the DOM.
2. Time each one. Screenshot at 0s, 3s and 6s after load; content identical at
   3s and 6s did not last more than 5 seconds and the criterion is not engaged.
3. Check parallelism. A full-screen splash animation with nothing else on
   screen is not in parallel; a carousel beside body copy is.
4. Find the control - pause, stop, hide, or an update-frequency setting - and
   confirm it is keyboard reachable, named, and actually stops the motion.
   Snapshot the pixels or the tree after activating it.
5. Note whether `prefers-reduced-motion` is honoured. It is not a substitute
   for the control.

### Genuine failure

- A hero carousel auto-advancing every 4 seconds with arrows and dots but no
  pause control.
- A marquee price ticker running continuously beside article text.
- A looping background video behind the main content with no pause affordance.
- A feed that re-renders every 10 seconds and moves the item being read.
- A pause button that stops the animation but not the auto-advance timer, so
  the slide changes anyway.

### False positive - do not report

- Motion that finishes inside 5 seconds - an entrance animation, a hover
  transition, a spinner for a request that resolves.
- A loading indicator tied to an operation that is genuinely still running.
- Motion the user started and can stop the same way, such as a video they
  played.
- A full-screen animation with no parallel content.
- Motion already suppressed under `prefers-reduced-motion` in the state tested.

---

## 2.4.1 Bypass Blocks - Level A

### What the standard requires

A mechanism is available to bypass blocks of content repeated on multiple
pages. A skip link is the common answer; correctly nested headings and ARIA
landmark regions each satisfy the criterion on their own.

### How to test it

1. Focus `body`, press Tab once, and read `document.activeElement`. A skip link
   is normally the first stop.
2. Check it is announced: a real `a` with an `href` beginning `#`, non-empty
   text, not `aria-hidden="true"`.
3. Activate it with Enter, then read `document.activeElement` again. **Focus
   must have moved to the target.** Scrolling while focus stays on the link is
   a failure: the next Tab returns the user to the navigation they just skipped.
4. Inspect the target. It must exist and be focusable - `tabindex="-1"` on the
   container or heading, or a natively focusable element. `#main` on a plain
   `main` with no `tabindex` does not take focus in every browser.
5. With no skip link, check the alternatives before ruling: a `main` landmark
   alongside `nav`, `header` and `footer`, or a heading outline covering each
   repeated block. Either satisfies 2.4.1.

### Genuine failure

- No skip link, no landmarks and a flat heading structure, with 40 navigation
  links before the content on every page.
- A skip link whose target does not exist - `href="#main"` with no `#main`.
- A skip link whose target is not focusable, so activating it scrolls the page
  and leaves focus in the navigation. A real failure: focus does not move, so
  the block is not bypassed.
- A skip link rendered as a `span` with a click handler, unreachable by
  keyboard.
- A skip link hidden with `display: none`, which removes it from the tab order.

### False positive - do not report

- A skip link that is visually hidden with the clip pattern and **stays** hidden
  when focused, provided it is keyboard reachable, announced, and moves focus
  to a focusable target. It passes 2.4.1. Report it as a minor usability note
  for sighted keyboard users, never as a 2.4.1 failure.
- A page with no skip link but a correct landmark structure, or a correct
  heading outline. Either mechanism suffices alone.
- A single-page application view with no repeated block above the content.
- A skip link landing on a container rather than on the first heading.
- Several skip links - to content, to search, to the footer. More than one is
  fine.

---

## Reporting rules for this group

- One finding per element per criterion. A carousel that autoplays with sound
  and cannot be paused is a 1.4.2 finding and a 2.2.2 finding against the same
  component.
- Severity follows what the user loses. `critical` where the page becomes
  unusable - a keyboard trap that ends the session, a timeout that destroys a
  submitted application, sound that cannot be silenced over a screen reader.
  `serious` where the task is completable but hostile - an unpausable ticker
  beside the content, no bypass mechanism on a page with a 40-item menu.
  `minor` for a skip link that never becomes visible, or a documented shortcut
  that is hard to trigger by accident.
- Evidence discipline. Quote the times you measured, the stop index, the key
  you pressed and what changed in the tree afterwards. "Session times out" is
  not a finding; "the session expired 14m 55s after load with no prior warning
  and the form fields were cleared" is. Never invent a selector or a file path;
  where you have none, use null.
- Verdict policy for this lane: 2.1.4 and 2.2.1 are FLAG on every finding -
  whether a limit is essential and whether a shortcut is a genuine barrier are
  human judgements, and you supply the evidence rather than the ruling. 1.4.2,
  2.1.2, 2.2.2 and 2.4.1 are DECIDE when you observed the behaviour yourself.
  Where you could not observe it - audio blocked by the autoplay policy, a
  timeout longer than the run budget - use BLOCKED and say which observation
  you were unable to make.
