---
name: wcag-operable-pointer
description: The runtime view of WCAG 2.5.1 Pointer Gestures, 2.5.2 Pointer Cancellation and 2.5.7 Dragging Movements, judged by driving a real pointer in the browser rather than by reading source. Load when testing swipe-only carousels, custom sliders, sortable lists, kanban boards, split panes, map panning, or any control that fires on pointerdown.
---

# Pointer gestures, cancellation and dragging, from the browser

Three criteria, all judged by moving a real pointer and watching what the page
does. You press, you drag, you release somewhere unexpected, and you diff the
accessibility tree either side to find out whether the page did something it
should not have.

Lane: ACT. All three are FLAG in this lane. Whether an alternative is genuinely
equivalent, and whether down-event activation is essential for this particular
component, are human judgements. You supply the observation and the evidence;
a person rules.

A companion skill, `wcag-gestures-source`, covers 2.5.1, 2.5.4 and 2.5.7 from
the repository source in the CODE lane - the handlers, the gesture libraries,
the sensors. This skill covers only what a driven pointer can observe. Do not
duplicate source-reading advice here, do not speculate about libraries you
cannot see, and do not report 2.5.4 at all: motion actuation has no runtime
surface in a desktop browser session.

---

## 2.5.1 Pointer Gestures - Level A

### What the standard requires

All functionality that uses a multipoint or path-based gesture for operation
can also be operated with a **single pointer without a path-based gesture**,
unless the multipoint or path-based gesture is essential.

| Gesture kind | Examples |
|---|---|
| Multipoint | Pinch to zoom a map, two-finger rotate, three-finger tap |
| Path-based | Swipe a carousel, drag a value along a track, swipe-to-delete a row, draw a signature, slide-to-unlock |

Single pointer without a path means the endpoint decides the outcome: a click,
a tap, a double click, a long press. Where the intermediate points of the
movement matter, it is path-based.

### How to test it

1. Identify candidate gestures from the rendering: carousels with dot or edge
   affordances, list rows that hint at swipe, sliders, map surfaces, image
   comparison handles, pinch-zoomable galleries, signature pads.
2. Reproduce the gesture to establish the function exists. For a swipe:

   ```js
   await page.mouse.move(x0, y0);
   await page.mouse.down();
   for (const step of path) await page.mouse.move(step.x, step.y);
   await page.mouse.up();
   ```

   For multipoint, dispatch two touch points through CDP
   `Input.dispatchTouchEvent` with two entries in `touchPoints`, moving them
   apart or together.
3. Snapshot the accessibility tree before and after. A changed tree proves the
   gesture drives a real function, which is what puts the component in scope.
4. Now look for the single-pointer route to the **same outcome**. Reload to a
   clean state, then click each visible control - arrows, dots, a zoom in and
   out button pair, an overflow menu item - and diff the tree against the
   post-gesture snapshot from step 3. A match means the alternative exists.
5. Record what you clicked and what you did not find. The FLAG is only useful
   if a human can see where you looked.

### Genuine failure

- A carousel that advances only when dragged across it: no arrows, no dots, no
  keyboard route, and the tree after a click on any visible control is
  unchanged.
- A list row whose delete action exists only as a swipe, with no menu, button
  or long-press equivalent.
- A map whose only zoom is pinch, with no plus and minus controls.
- An image comparison slider that reveals the second image only while a handle
  is dragged along its track, with no percentage control or click-to-position.
- A "slide to confirm" control as the sole way to submit an order.

### False positive - do not report

- A gesture that is one of several routes. If arrows or dots also work, the
  swipe is a convenience and the criterion is met.
- Browser and operating system gestures: pinch zoom of the whole page,
  two-finger scroll, swipe-to-go-back. Out of the author's scope entirely.
- Gestures where the path is the content: a drawing canvas, a signature pad
  used as a signature, a handwriting input field. Essential.
- A single-pointer alternative that is slower or clumsier than the gesture.
  Equivalent outcome is the bar, not equivalent convenience.
- A component you could not drive because the harness could not synthesise
  touch. Report BLOCKED and say so; do not infer a failure from silence.

---

## 2.5.2 Pointer Cancellation - Level A

### What the standard requires

For functionality operated with a single pointer, at least one is true: the
down-event is not used to execute any part of the function; or the function
completes on the up-event and a mechanism aborts it before completion or undoes
it afterwards; or the up-event reverses the outcome of the down-event; or
down-event activation is essential.

### How to test it

The drag-off test. Run it on every control you can reach.

1. Snapshot the accessibility tree, and note any observable side effect the
   action would produce - a URL change, a dialog, a toast, a mutated value.
2. Press and drag away, well outside the target rect, then release:

   ```js
   const box = await locator.boundingBox();
   await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
   await page.mouse.down();
   await page.mouse.move(box.x + box.width + 300, box.y + box.height + 300, { steps: 10 });
   await page.mouse.up();
   ```

3. Snapshot the tree again and diff it against step 1. **Nothing should have
   changed.** A diff means the function fired on `pointerdown` or `mousedown`
   and the user had no way to abort it.
4. Where the diff shows the action fired, look for the escape hatches before
   reporting: an undo affordance, a confirmation step, or an up-event that
   reverses the down-event. Record which you checked.
5. Also watch `page.url()` and any navigation event. A link that navigates on
   `mousedown` is the same failure in a different costume.
6. Repeat the sequence releasing back **on** the target, to confirm the control
   works normally. A control that does nothing either way is a different
   finding.

### Genuine failure

- A delete button wired to `onMouseDown` that removes the row even when the
  pointer is released 300px away.
- A custom menu that commits the highlighted item on `pointerdown`, so a
  mis-press cannot be walked off.
- A card grid where `mousedown` navigates, so pressing and dragging to select
  text takes the user to another page.
- A toggle that switches state on `pointerdown` and does not switch back when
  the pointer leaves and releases elsewhere.
- A "buy now" control that submits on the down event with no confirmation and
  no undo.

### False positive - do not report

- Any control that fires on `click`, `pointerup` or `mouseup`. That is the
  default and the criterion is met.
- Down-event behaviour that is only visual - a pressed state, a ripple, a
  focus ring. Nothing executed, so nothing to cancel.
- Down-event activation that is essential: a piano keyboard app, a drum pad, a
  drawing canvas, a push-to-talk control, a games surface where the press is
  the input.
- A drag operation whose down event starts the drag. Starting a drag is not
  executing the function; dropping is.
- A down-event action with a visible undo, such as a sortable list that offers
  "Undo move" after the drop.

---

## 2.5.7 Dragging Movements - Level AA

### What the standard requires

All functionality that uses a dragging movement for operation can be achieved
by a **single pointer without dragging**, unless dragging is essential or the
functionality is determined by the user agent and not modified by the author.
A click, a tap, a long press, or a pair of buttons all qualify. Keyboard
support is welcome but does not by itself satisfy this criterion, which is
about pointer users who cannot drag accurately.

### How to test it

1. Sweep for draggable surfaces: sortable and reorderable lists, kanban
   boards, custom sliders and range handles, split panes and resizers, map
   panning, image croppers and rotation handles, colour pickers, calendar event
   resizing, file drop zones, carousels with a drag track.
2. Confirm dragging is the mechanism. Use the down, move, up sequence from
   2.5.2, releasing on a plausible destination, and diff the tree. A changed
   order, position or value proves the function is drag-driven.
3. Reload to a clean state and hunt for the non-dragging route to the same
   outcome: move up and move down buttons, a "move to" menu, click-source then
   click-destination, a numeric input beside a slider, plus and minus buttons,
   a file picker beside the drop zone.
4. Exercise the candidate alternative with single clicks and diff the resulting
   tree against the post-drag snapshot. Same outcome means the criterion is
   met, and you say so rather than reporting.
5. Note where you looked when there is no alternative. "No move controls in the
   row, none in the row overflow menu, none in the list toolbar" is the useful
   part of the finding.

### Genuine failure

- A sortable list where reordering exists only as a drag, with no move
  controls and no reorder dialog.
- A kanban board whose cards can change column only by dragging.
- A price range filter built from two custom handles on a track, with no
  numeric inputs and no preset ranges.
- A split pane resizer that is drag-only, where the panes cannot be resized or
  reset any other way.
- An image cropper whose crop box can only be dragged and resized by dragging,
  with no aspect-ratio presets or numeric fields.
- A file upload that accepts only a drop, with no "choose a file" button.

### False positive - do not report

- A native `input type="range"`. It is keyboard operable, it is the user
  agent's own behaviour, and it passes.
- A native `select`, a native scrollbar, native text selection, or any other
  user-agent behaviour the author has not replaced.
- A drag with a visible move up and move down alternative, even when the
  alternative takes more clicks. Less convenient is not a failure.
- Map panning where arrow buttons, a search field or clickable results also
  reposition the map.
- Drawing, painting and signature surfaces where the drag path is the content.
  Essential.
- A drag handle that also responds to click-then-click placement, which you
  should test before ruling.

---

## Reporting rules for this group

- One finding per element per criterion. A sortable list that reorders on
  `pointerdown` and offers no click alternative is a 2.5.2 finding and a 2.5.7
  finding against the same component.
- Severity follows the task. `critical` where the component is the only route
  through the page's primary task - a drag-only checkout confirmation, a
  swipe-only step in an application form. `serious` where a real function is
  unavailable but the task survives - a drag-only reordering of saved items.
  `minor` where the affected function is peripheral or duplicated elsewhere on
  the site.
- Evidence discipline. Give the selector you drove, the coordinates or
  offsets you used, and the tree diff that proves the outcome. Say explicitly
  which alternatives you clicked and which you found absent - a FLAG with no
  record of the search is unusable to the human who receives it. Never invent a
  selector, and never name a source file from this lane; source belongs to
  `wcag-gestures-source`.
- Verdict policy for this lane: `verdict` is always FLAG, on every finding,
  however clear the observation. Where the harness could not synthesise the
  input at all - no touch emulation, a canvas that ignores synthetic events -
  say what you could not drive in `detail` and use BLOCKED rather than guessing.
