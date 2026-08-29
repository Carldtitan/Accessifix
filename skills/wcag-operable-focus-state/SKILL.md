---
name: wcag-operable-focus-state
description: Keyboard operability and focus behaviour under WCAG 2.1.1 Keyboard, 2.4.3 Focus Order, 2.4.7 Focus Visible, 2.4.11 Focus Not Obscured Minimum and 1.4.13 Content on Hover or Focus, all decided by driving the UI rather than by reading a snapshot. Load whenever you tab a page, open a dialog, check a focus indicator, test a sticky header against the focused element, or hover a tooltip.
---

# Keyboard operability and focus behaviour

Five criteria, and not one of them can be judged from a static screenshot or a
static DOM dump. Each is a comparison of the page before an interaction against
the page after it - before and after a Tab press, before and after a dialog
opens, before and after the pointer lands on a trigger. No driving, no
evidence, no finding.

Lanes: VIS and ACT, both owning all five. All five are DECIDE and all five are
state-dependent, which makes this the highest-value group in the product.

Reuse the ACT templates: toggle (snapshot, act, snapshot, diff), dialog (open,
assert focus inside, Escape, assert focus returned), form. Tab the page once,
record everything at every stop, and rule all five criteria from that recording.

---

## 1.4.13 Content on Hover or Focus - Level AA

### What the standard requires

Content that appears on pointer hover or keyboard focus and disappears again
must be **dismissable** (cleared without moving the pointer and without moving
focus, normally by Escape), **hoverable** (the pointer can travel onto it
without it vanishing) and **persistent** (it stays until dismissed, until focus
moves away, or until its information stops being valid). Content whose
presentation is user-agent controlled is exempt, and the dismiss requirement
relaxes for an input error message and for content that obscures nothing.

### How to test it

1. Enumerate triggers: `[data-tooltip]`, `aria-describedby` pointing at a
   hidden node, help icons, hover submenus, link previews, and CSS shaped like
   `:hover .popover` or `:hover::after`.
2. Park the pointer with `mouse.move`, wait for the content, capture a
   screenshot and a tree snapshot. That pair is the baseline for all three.
3. **Dismissable.** Pointer still on the trigger, focus unmoved, press Escape.
   The content must be gone. Moving the pointer away to make it vanish does not
   count and must never be used as the test.
4. **Hoverable.** Move onto the content in small steps, crossing any gap
   between trigger and bubble. One long jump passes bubbles a user would lose.
5. **Persistent.** Rest on the trigger ten seconds with no input, then snapshot.
6. Repeat 3 to 5 from keyboard focus where the content also appears on focus.

### Genuine failure

- A `[data-tooltip]` bubble with no Escape handler, so a user at 400% zoom
  cannot clear it off the text it covers.
- A bubble with a gap below its trigger: `mouseleave` fires mid-travel.
- `.nav-item:hover .submenu` closing on a 300ms timeout wherever the pointer is.
- Content torn down by `setTimeout(hide, 3000)` with the pointer still resting.
- `a:hover::after { content: attr(data-tip) }` - a pseudo-element can be
  neither hovered nor dismissed, so it fails two properties at once.
- Content that appears on hover and never on focus. Also a 2.1.1 finding.

### False positive - do not report

- A native `title` tooltip. Browser-controlled and explicitly exempt. Never
  open a 1.4.13 finding on `title`.
- Other user-agent surfaces: the `select` popup, the date picker, autofill.
- A popover with a visible close control that also clears on Escape and never
  self-hides. Awkward positioning is not a 1.4.13 failure.
- An inline validation message that appears on blur and obscures nothing.
- Content that goes because its information expired, such as a "copied" note.

---

## 2.1.1 Keyboard - Level A

### What the standard requires

All functionality operable through a keyboard interface, without requiring
specific timings for individual keystrokes. One exception: input depending on
the path of the user's movement rather than its endpoints, which means
free-hand drawing and nothing more generous.

### How to test it

1. Click a dead area so `document.activeElement` is `body`, then Tab to the end
   of the document, recording at every stop the index, role, accessible name,
   selector and `getBoundingClientRect()`. Cap the walk at twice the number of
   interactive-looking elements.
2. From the screenshot list everything that looks operable - buttons, links,
   custom widgets, sliders, tabs, menus, tree items, drag handles, map and
   canvas controls, clickable cards - and subtract the recorded stops. What
   remains is the candidate list.
3. At each stop operate the control with the keys its role mandates, diffing
   the tree either side: Enter on a link, Enter and Space on a button, Space on
   a checkbox, arrows plus Home and End in a radio group, tab list, menu,
   listbox, slider or tree, Escape on a menu or dialog.
4. Before ruling on anything missing from the tab order, look for a legitimate
   route: roving `tabindex`, or activation from a reachable parent.
5. Test timing dependence. Double-click-only, long-press-only, or two keys
   inside a window all fail even where a keyboard route exists.

### Genuine failure

- `div class="btn"` with an `onClick`, no `tabindex`, no key handler.
- `role="button"` plus `tabindex="0"` with only a `click` listener: reachable
  and still dead, because a non-button synthesises no click from Enter or Space.
- A custom combobox whose listbox opens on click while arrows do nothing.
- A carousel whose only next and previous affordance is a swipe region.
- A slider built from a draggable handle with no arrow keys. Also 2.5.7.
- A menu that opens on `mouseenter` only.

### False positive - do not report

- Roving `tabindex`. One stop for a tab list, toolbar, menu or grid with arrows
  moving inside it is the correct pattern.
- A free-hand drawing surface. Path-dependent input is the standard's exception.
- A `disabled` control that is unreachable because it is disabled.
- Content inside a collapsed disclosure, provided the disclosure is operable.
- A pointer convenience duplicating a reachable control, such as a right-click
  menu whose items all exist as visible buttons.

---

## 2.4.3 Focus Order - Level A

### What the standard requires

Where a page can be navigated sequentially and the sequence affects meaning or
operability, components receive focus in an order that preserves meaning and
operability. The question is not "does it match the visual order" but "does the
order this user gets still make sense and still work".

### How to test it

1. Take the tab recording from 2.1.1 and compare each stop's rect against
   reading order for the page's writing direction. Flag only deviations that
   change meaning or break operability - a control reached before the thing it
   acts on, a sequence crossing between columns mid-form.
2. Run the dialog template on every dialog, drawer, off-canvas menu and
   popover, recording the accessible name of `document.activeElement` at three
   moments: before activating the trigger, after the dialog opens, after it
   closes. Focus must move into the dialog on open and return to the invoking
   element on close.
3. Tab one full cycle inside the open dialog and record where focus goes if it
   leaves.
4. Re-record the sequence after content is inserted - an accordion panel, "load
   more" results, an injected error summary. New content must fall next in the
   order, not at the end of the document.
5. Check hidden-but-focusable content: a panel moved out of view with
   `transform: translateX(-100%)` and no `display: none`, `visibility: hidden`
   or `inert` is still in the tab order. Check CSS reordering too - `order`,
   `row-reverse`, `grid-area`, absolute positioning.

### Genuine failure

- A modal that opens leaving focus on the trigger behind the overlay, so the
  next Tab walks into the page underneath.
- A dialog that closes and drops focus to `body`, restarting the sequence at
  the top of the document.
- A closed off-canvas menu still in the tab order - consecutive stops where the
  focused element is entirely off screen.
- A two-column layout using `order`, so the sequence alternates between columns
  halfway through a form.
- An error summary shown at the top of the form but appended to the end of the
  DOM, reached only as the last stop on the page.
- `tabindex="1"` on the search field, hoisting it in front of the skip link and
  the whole navigation - the recorded sequence proves the harm.

### False positive - do not report

- Positive `tabindex` on its own. A smell worth noting, and a 2.4.3 failure
  only when the resulting order actually breaks meaning or operability. Record
  the sequence before ruling.
- A deviation from visual order that changes nothing, such as footer utility
  links reached in a different order from their visual columns.
- Focus landing on the dialog container (`role="dialog"` with `tabindex="-1"`)
  rather than the first control inside. Both patterns conform.
- A skip link as the first stop even though it is invisible until focused.
- A modal that deliberately traps focus. That is the correct pattern and it
  passes 2.1.2 as long as Escape or a visible close control gets the user out.
  2.1.2 belongs to `wcag-operable-control`; never report an intentional trap.
- Any page whose sequence you did not record. No recording, no finding.

---

## 2.4.7 Focus Visible - Level AA

### What the standard requires

Any keyboard-operable interface has a mode of operation where the focus
indicator is visible. At AA the bar is presence, not quality: something must
change visually when a component takes focus. Thickness, contrast and size are
2.4.13 at AAA and out of scope here.

### How to test it

The tab-stop-screenshot-diff technique, run once for the whole page.

1. Blur everything - click a dead region, or `blur()` the active element - and
   take a baseline screenshot.
2. Press Tab once, then read `document.activeElement`, its accessible name, its
   selector and its `getBoundingClientRect()`.
3. Screenshot with `clip` set to that rect inflated by 10 CSS pixels on every
   side. Inflation matters: `outline-offset`, `box-shadow` rings and underlines
   paint outside the border box, and a tight clip reports them as no change.
4. Crop the same region from the baseline and compare pixel by pixel. Any
   difference passes that stop; zero difference fails it. Record index,
   accessible name and result for every stop.
5. If the page scrolled to reveal the element, re-take the baseline crop after
   the scroll settles, and compare the element's box rather than absolute page
   coordinates.
6. Always arrive by Tab, never by clicking - `:focus-visible` fires for the
   keyboard and not the pointer - and wait for transitions to finish. A 200ms
   ring fade photographed at 0ms diffs to nothing.

### Genuine failure

- `*:focus { outline: none }` with no replacement: zero diff at every stop.
- A reset that strips outlines and restores focus styling for `a` and `button`
  only, leaving `[role="button"]`, `summary` and `[tabindex="0"]` cards bare.
- An indicator declared only under `:hover`.
- `outline-color` equal to the element's own background: a real rule, no change.
- A focus style on a wrapper with `display: contents` or zero dimensions.

### False positive - do not report

- The browser default focus ring, in any browser, however plain. It is a
  visible indicator and it passes. Never file "the focus ring is the default"
  or "the focus ring is ugly".
- A thin, faint or low-contrast indicator. Appearance thresholds are 2.4.13 at
  AAA. Report only zero visible change.
- `outline: none` paired with a replacement - a `box-shadow` ring, a border
  swap, a background change, an underline. Diff it before ruling.
- A stop whose screenshot you took before the transition finished.
- A control absent from the tab order under a roving `tabindex` pattern.

---

## 2.4.11 Focus Not Obscured (Minimum) - Level AA

### What the standard requires

When a component receives keyboard focus it is not **entirely** hidden by
author-created content. Partial obscuring passes at AA; complete coverage
fails. If the user can reveal the item without moving focus - closing a banner
with Escape, say - it is not considered hidden.

### How to test it

1. Inventory floating author content in the state a first-time visitor sees:
   sticky headers, fixed footers and action bars, cookie banners, chat widgets,
   back-to-top buttons, promo bars, toasts, sticky table headers.
2. Dismiss none of it. Tab the page with all of it present.
3. At each stop capture the focused element's `getBoundingClientRect()`, each
   floating element's rect, and their paint order or `z-index`.
4. Rule fully obscured when the focused rect lies entirely inside the union of
   the rects painting above it, or falls outside the viewport after the browser
   scrolled it into view - the classic case of a control scrolled under a
   sticky header because the scroll container has no `scroll-padding-top`.
5. Confirm with pixels: screenshot the viewport at that stop and check whether
   any part of the focused element is visible. Geometry misleads when a
   floating element is transparent or smaller than its box.
6. Test the exception before reporting. A header that collapses on keyboard
   focus, or a banner Escape closes while focus stays put, is not a failure.

### Genuine failure

- An 80px sticky header with no `scroll-padding-top` on the scrolling
  container, so each control tabbed to down the page lands beneath it and is
  completely covered.
- A cookie banner fixed to the bottom, not focus-trapped, covering the footer
  links entirely as the sequence reaches them.
- A chat widget anchored bottom-right sitting on top of the submit button.
- A sticky "Save and continue" bar covering the last radio group of a long form
  at the moment that group takes focus.
- A toast over the focused control that cannot be dismissed from the keyboard.

### False positive - do not report

- Partial obscuring. Half the control visible passes at AA; complete
  visibility is 2.4.12 at AAA.
- User-agent content: the find bar, autofill dropdown, download shelf, an
  extension overlay. Only author content counts.
- Content the user opened that closes without moving focus, where Escape
  reveals the focused element again.
- A focused element off screen because a smooth scroll had not finished.
- Content behind an open modal. The focused element is inside the modal.

---

## Reporting rules for this group

- One finding per element per criterion. A custom slider that cannot be reached
  (2.1.1), shows no indicator when it is (2.4.7) and sits under a sticky bar
  (2.4.11) is three findings.
- Severity follows the user's task. `critical` where the primary task cannot be
  completed by keyboard at all - an unreachable submit control, a dialog with
  no exit, no focus indicator anywhere. `serious` where the task survives but
  the user is disoriented - a dialog dropping focus to `body`, a form section
  vanishing under a sticky header. `minor` for one off-order footer link, or a
  tooltip that is hoverable and persistent but not dismissable.
- Evidence discipline. Cite the artefact you produced: the stop index and the
  accessible name at that stop, the path of the clipped screenshot, the two
  bounding rects you compared, the three focus positions from the dialog
  template. Never invent a selector. If an overlay swallowed the click or the
  page never settled, that is BLOCKED with the reason in `detail`, not a
  failure.
- Verdict policy for this lane: all five are DECIDE, because driving the UI
  settles them. Use FLAG only where the judgement is about meaning rather than
  mechanics, such as whether an unusual tab order truly breaks understanding.
  Handed a static screenshot and no way to interact, you cannot rule on
  anything here - return nothing rather than inferring behaviour from CSS.
