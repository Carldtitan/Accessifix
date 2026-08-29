---
name: wcag-operable-pointer
description: The runtime view of WCAG 2.5.1 Pointer Gestures, 2.5.2 Pointer Cancellation and 2.5.7 Dragging Movements, judged by driving a real pointer in the browser rather than by reading source. Load when testing swipe-only carousels, custom sliders, sortable lists, kanban boards, split panes, map panning, or any control that fires on pointerdown.
---

# Pointer gestures, cancellation and dragging, from the browser

Three criteria judged by moving a real pointer and watching what the page does.
You press, you drag, you release somewhere unexpected, and you diff the
accessibility tree either side to find out whether the page did something it
should not have.

Lane: ACT. All three are FLAG here. Whether an alternative is genuinely
equivalent, and whether down-event activation is essential for this component,
are human judgements. You supply the observation; a person rules.

A companion skill, `wcag-gestures-source`, covers 2.5.1, 2.5.4 and 2.5.7 from
the repository source in the CODE lane - the handlers, the libraries, the
sensors. This skill covers only what a driven pointer can observe. Do not
duplicate source-reading advice, do not speculate about libraries you cannot
see, and do not report 2.5.4 at all: motion actuation has no runtime surface in
a desktop browser session.

---

## 2.5.1 Pointer Gestures - Level A

### What the standard requires

Functionality using a multipoint gesture (pinch, two-finger rotate) or a
path-based gesture (swipe, drag along a track, trace a signature) must also be
operable with a single pointer without a path, unless the gesture is essential.
Single pointer without a path means the endpoint decides the outcome - a click,
a tap, a double click, a long press. Where the intermediate points matter, the
gesture is path-based and the criterion is engaged.

### How to test it

1. Identify candidates from the rendering: carousels, list rows that hint at
   swipe, sliders, map surfaces, image comparison handles, pinch-zoom
   galleries, signature pads.
2. Reproduce the gesture to prove the function exists:

   ```js
   await page.mouse.move(x0, y0);
   await page.mouse.down();
   for (const step of path) await page.mouse.move(step.x, step.y);
   await page.mouse.up();
   ```

   For multipoint, dispatch CDP `Input.dispatchTouchEvent` with two entries in
   `touchPoints`, moving them apart or together.
3. Snapshot the accessibility tree either side. A changed tree proves the
   gesture drives a real function, which is what puts the component in scope.
4. Reload to a clean state and hunt the single-pointer route to the **same
   outcome**: click each visible control - arrows, dots, a zoom button pair, an
   overflow menu item - and diff against the post-gesture snapshot from step 3.
5. Record what you clicked and what you did not find. A FLAG is only useful if
   a human can see where you looked.

### Genuine failure

- A carousel that advances only when dragged: no arrows, no dots, and clicking
  every visible control leaves the tree unchanged.
- A list row whose delete exists only as a swipe, with no menu, button or
  long-press equivalent.
- A map whose only zoom is pinch, with no plus and minus controls.
- An image comparison slider that reveals the second image only while a handle
  is dragged along its track.
- A "slide to confirm" control as the sole way to submit an order.

### False positive - do not report

- A gesture that is one of several routes. Working arrows or dots mean the
  swipe is a convenience and the criterion is met.
- Browser and operating system gestures - pinch zoom of the whole page,
  two-finger scroll, swipe to go back. Out of the author's scope entirely.
- Gestures where the path is the content: drawing, handwriting, a signature pad
  used as a signature. Essential.
- A single-pointer alternative that is slower or clumsier. Equivalent outcome
  is the bar, not equivalent convenience.
- A component you could not drive because the harness could not synthesise
  touch. Report BLOCKED; do not infer a failure from silence.

---

## 2.5.2 Pointer Cancellation - Level A

### What the standard requires

For single-pointer activation, at least one must hold: the down-event executes
no part of the function; or the function completes on the up-event with a
mechanism to abort before completion or undo afterwards; or the up-event
reverses the outcome of the down-event; or down-event activation is essential.

### How to test it

The drag-off test, run on every control you can reach.

1. Snapshot the accessibility tree and note any side effect the action would
   produce - a URL change, a dialog, a toast, a mutated value.
2. Press, drag well outside the target rect, and release:

   ```js
   const box = await locator.boundingBox();
   await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
   await page.mouse.down();
   await page.mouse.move(box.x + box.width + 300, box.y + box.height + 300, { steps: 10 });
   await page.mouse.up();
   ```

3. Snapshot again and diff against step 1. **Nothing should have changed.** A
   diff means the function fired on `pointerdown` or `mousedown` and the user
   had no way to abort it.
4. Where it did fire, check the escape hatches before reporting: an undo
   affordance, a confirmation step, or an up-event that reverses the
   down-event. Record which you checked.
5. Watch `page.url()` and navigation events too. A link that navigates on
   `mousedown` is the same failure in a different costume.
6. Repeat releasing back on the target, to confirm the control works at all.

### Genuine failure

- A delete button wired to `onMouseDown` that removes the row even when the
  pointer is released 300px away.
- A custom menu that commits the highlighted item on `pointerdown`, so a
  mis-press cannot be walked off.
- A card grid where `mousedown` navigates, so pressing and dragging to select
  text takes the user to another page.
- A toggle that switches on `pointerdown` and does not switch back when the
  pointer leaves and releases elsewhere.
- A "buy now" control that submits on the down event with no undo.

### False positive - do not report

- Any control firing on `click`, `pointerup` or `mouseup`. That is the default
  and the criterion is met.
- Down-event behaviour that is only visual - a pressed state, a ripple, a focus
  ring. Nothing executed, so nothing to cancel.
- Essential down-event activation: a piano keyboard app, a drum pad, a drawing
  canvas, push-to-talk, a games surface where the press is the input.
- A drag whose down event starts the drag. Starting a drag is not executing the
  function; dropping is.
- A down-event action with a visible undo, such as "Undo move" after a drop.

---

## 2.5.7 Dragging Movements - Level AA

### What the standard requires

Functionality using a dragging movement must be achievable with a single
pointer without dragging, unless dragging is essential or the behaviour belongs
to the user agent. A click, a long press, a click-then-click placement or a
pair of move buttons all qualify. Keyboard support is welcome but does not by
itself satisfy this criterion, which is about pointer users who cannot drag
accurately.

### How to test it

1. Sweep for draggable surfaces: sortable lists, kanban boards, custom sliders
   and range handles, split panes and resizers, map panning, image croppers and
   rotation handles, colour pickers, calendar event resizing, file drop zones,
   carousels with a drag track.
2. Confirm dragging is the mechanism. Use the down, move, up sequence from
   2.5.2 releasing on a plausible destination, and diff the tree. A changed
   order, position or value proves the function is drag-driven.
3. Reload and hunt the non-dragging route to the same outcome: move up and move
   down buttons, a "move to" menu, click-source then click-destination, a
   numeric input beside a slider, plus and minus buttons, a file picker beside
   the drop zone.
4. Exercise that candidate with single clicks and diff the result against the
   post-drag snapshot. A match means the criterion is met and you say so rather
   than reporting.
5. Where there is no alternative, record where you looked. "No move controls in
   the row, none in its overflow menu, none in the list toolbar" is the useful
   part of the finding.

### Genuine failure

- A sortable list where reordering exists only as a drag, with no move controls
  and no reorder dialog.
- A kanban board whose cards change column only by dragging.
- A price range filter built from two custom handles on a track, with no
  numeric inputs and no presets.
- A drag-only split pane resizer with no reset and no size presets.
- An image cropper whose crop box is drag-only, with no ratio presets or
  numeric fields.
- A file upload that accepts only a drop, with no "choose a file" button.

### False positive - do not report

- A native `input type="range"`. Keyboard operable, user-agent behaviour, and
  it passes.
- A native `select`, a native scrollbar, native text selection, or any other
  user-agent behaviour the author has not replaced.
- A drag with a visible move up and move down alternative, even when the
  alternative takes more clicks. Less convenient is not a failure.
- Map panning where arrow buttons, a search field or clickable results also
  reposition the map.
- Drawing, painting and signature surfaces where the drag path is the content.
- A drag handle that also accepts click-then-click placement, which you should
  test before ruling.

---

## Reporting rules for this group

- One finding per element per criterion. A sortable list that reorders on
  `pointerdown` and offers no click alternative is a 2.5.2 finding and a 2.5.7
  finding against the same component.
- Severity follows the task. `critical` where the component is the only route
  through the page's primary task - a drag-only checkout confirmation, a
  swipe-only step in an application form. `serious` where a real function is
  unavailable but the task survives, such as drag-only reordering of saved
  items. `minor` where the function is peripheral or duplicated elsewhere.
- Evidence discipline. Give the selector you drove, the coordinates or offsets
  you used, and the tree diff that proves the outcome. Say which alternatives
  you clicked and which were absent - a FLAG with no record of the search is
  unusable to the human who receives it. Never invent a selector, and never
  name a source file from this lane; source belongs to `wcag-gestures-source`.
- Verdict policy for this lane: `verdict` is always FLAG, on every finding,
  however clear the observation. Where the harness could not synthesise the
  input - no touch emulation, a canvas that ignores synthetic events - say what
  you could not drive in `detail` and use BLOCKED rather than guessing.
