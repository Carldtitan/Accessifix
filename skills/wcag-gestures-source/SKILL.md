---
name: wcag-gestures-source
description: Reading repository source for WCAG 2.5.1 Pointer Gestures, 2.5.4 Motion Actuation and 2.5.7 Dragging Movements, which live in event handlers and never appear in the rendered DOM. Load when auditing gesture libraries, touch and pointer handlers, drag-and-drop code, device motion or orientation listeners, and custom sliders in a codebase.
---

# Gesture and motion handlers in source

Three criteria no screenshot and no accessibility tree can reach. A swipe-only
carousel, a shake-to-undo listener and a drag-only sortable list all render as
ordinary markup; the whole behaviour sits in event handlers and in the
configuration of a third-party library. That is why this lane reads source
rather than pages.

Lane: CODE. All three are FLAG - whether an alternative is genuinely equivalent
is a human call, and the response schema accepts no other verdict.

**The rule that decides every finding here: the presence of a gesture handler
is not the failure. The absence of an equivalent single-pointer or conventional
alternative in the same component is.** Find the handler, then go looking for
the alternative, then report what you found either way. A finding that does not
say where you looked is not worth sending.

---

## 2.5.1 Pointer Gestures - Level A

### What the standard requires

Functionality operated by a multipoint gesture (pinch, two-finger rotate) or a
path-based gesture (swipe, drag along a track, trace a shape) must also be
operable with a single pointer without a path, unless the gesture is essential.
A click on a visible control reaching the same outcome satisfies it.

### How to test it

1. Grep the component tree for the signals:
   - `touchstart`, `touchmove`, `touchend`, and any branch on
     `e.touches.length > 1` or `e.changedTouches`
   - `gesturestart`, `gesturechange`, `gestureend`
   - `Hammer(`, `hammerjs`, `@use-gesture/react`, `useDrag`, `usePinch`,
     `react-swipeable`, `useSwipeable`
   - carousel libraries and their config: `swiper`, `embla-carousel`,
     `keen-slider`, `slick`, `glide`, `splide`
   - custom pinch maths: `Math.hypot` over two touch points, a scale derived
     from touch distance
2. Open each hit and decide what function the gesture performs. A `touchmove`
   computing a delta and changing an index is a swipe navigating a carousel. A
   `touchmove` that only calls `preventDefault()` performs no function at all.
3. Look for the alternative **inside the same component** before writing
   anything. For carousel libraries that means the arrow and dot props -
   `navigation`, `pagination`, `arrows`, `dots` - and whether they are actually
   enabled, not merely available.
4. Read the JSX or template output as well as the config. A library that
   supports arrows, configured with `navigation: false` and no arrow markup,
   has no alternative.
5. Record the file, the line, and the exact props you checked.

### Genuine failure

- `embla-carousel` with dragging enabled where the component renders slides and
  nothing else - no `scrollPrev` or `scrollNext` buttons in the file.
- A hand-rolled swipe deck computing `deltaX` in `touchmove` and calling
  `setIndex`, with dots rendered as non-interactive `span` elements.
- A pinch-zoom image viewer built from two-touch distance maths, with no zoom
  buttons and no double-tap handler in the component.
- A `react-swipeable` row action (`onSwipedLeft: deleteItem`) on a row with no
  menu, no delete button and no long-press handler.

### False positive - do not report

- `touchmove` used only to call `preventDefault()` for scroll locking, body
  freeze or overscroll suppression. No function, no gesture.
- A gesture library imported but not wired to any handler in the component.
- A carousel with `navigation: true` and arrow buttons in the markup. The swipe
  is then an extra route.
- Path-essential functionality: drawing, handwriting, signature capture.
- Browser-level pinch zoom of the whole page, and anything else the user agent
  provides that the code does not override.

---

## 2.5.4 Motion Actuation - Level A

### What the standard requires

Functionality operated by device motion or user motion must also be operable
through conventional user interface components, and the response to motion must
be disableable to prevent accidental actuation. Exempt: motion used through an
accessibility-supported interface, and motion that is essential to the function,
such as a pedometer or a bubble level.

### How to test it

1. Grep for the sensors:
   - `devicemotion`, `deviceorientation`, `deviceorientationabsolute`
   - `DeviceMotionEvent`, `DeviceOrientationEvent`, and any
     `requestPermission()` call on either
   - `Accelerometer`, `Gyroscope`, `LinearAccelerationSensor`,
     `AbsoluteOrientationSensor`
   - shake and tilt packages: `shake.js`, `react-shake`, tilt and parallax
     libraries that subscribe to orientation
2. Read what the listener does, and separate the two cases hard: does the
   motion trigger a **function** - undo, refresh, next, submit, navigate - or
   drive **decoration**, such as a parallax layer or a card tilt?
3. Where it triggers a function, look in the same component for a conventional
   control that does the same thing: an undo button, a refresh control, a menu
   item.
4. Look for the disable path: a settings flag, a stored preference, a
   `prefers-reduced-motion` guard, a documented toggle. Its absence is half the
   finding even when a conventional control exists.
5. Record the sensor, the function it triggers, and both searches.

### Genuine failure

- A `devicemotion` listener computing acceleration magnitude and calling
  `undoLastAction()` on a shake, with no undo control in the UI and no setting
  to turn it off.
- A tilt-to-scroll reading view subscribed to `deviceorientation` with no
  scrollbar, buttons or keyboard route in the same component.
- Shake-to-refresh on a data view where the shake is the only refresh route.
- A game control bound to orientation with no on-screen alternative and no
  disable option.

### False positive - do not report

- `deviceorientation` used only for a decorative parallax or lighting effect
  that carries no function. Nothing is actuated, so nothing needs an
  alternative.
- Motion that is the function itself - a pedometer, a spirit level.
- A listener behind a permission prompt where the feature is additive and a
  conventional control already exists.
- Sensor code inside a dependency the project never calls.
- `prefers-reduced-motion` guarded animation. A motion preference, not motion
  actuation.

---

## 2.5.7 Dragging Movements - Level AA

### What the standard requires

Functionality using a dragging movement must be achievable with a single
pointer without dragging, unless dragging is essential or the behaviour belongs
to the user agent. Click-then-click placement, a move up and move down pair, or
a "move to" menu all satisfy it. Keyboard support is what most libraries
provide and is a strong signal of care, so record it, but the criterion is
about pointer users who cannot drag accurately.

### How to test it

1. Grep for the signals:
   - HTML5 drag and drop: `dragstart`, `dragover`, `dragenter`, `drop`,
     `dragend`, `dataTransfer`, the `draggable` attribute
   - hand-rolled dragging: `pointerdown` paired with `pointermove` and
     `pointerup`, `setPointerCapture`, `mousedown` with a `mousemove` listener
     attached to `document`
   - libraries: `@dnd-kit/core`, `react-beautiful-dnd`, `@hello-pangea/dnd`,
     `react-dnd`, `sortablejs`, `react-sortablejs`, `interact.js`,
     `react-draggable`, `react-resizable`, `react-grid-layout`
   - custom slider thumbs: a `role="slider"` element with a `pointermove`
     handler, or a handle positioned from `clientX`
2. Identify the function: reorder, move between containers, resize, set a
   value, pan, crop, upload.
3. Search the same component for the alternative, in this order: rendered move
   or reorder buttons, a "move to" or overflow menu, a numeric input beside a
   slider, a file picker beside a drop zone, click-source then
   click-destination.
4. Then check the library's own keyboard support and name what you found:
   `dnd-kit` with a `KeyboardSensor` registered in `useSensors`;
   `react-beautiful-dnd` and `@hello-pangea/dnd`, which ship keyboard dragging
   through their drag handle props; `sortablejs`, which ships none.
5. Put all of that in `detail`: which file, which lines, which props and which
   sensors you checked.

### Genuine failure

- `sortablejs` initialised on a list with no move controls rendered and no
  keyboard handling added, at `components/PriorityList.tsx:31`.
- A `@dnd-kit/core` board configured with `useSensors(useSensor(PointerSensor))`
  only - no `KeyboardSensor` - and no move controls in the card component.
- A custom slider using `pointerdown` plus `pointermove` on a handle, with no
  numeric input, no step buttons and no key handling.
- A drop-zone upload built on `dragover` and `drop` with no `input type="file"`
  in the component.
- A `react-draggable` split pane with no reset control and no size presets.

### False positive - do not report

- `@dnd-kit/core` with a `KeyboardSensor` registered alongside the pointer
  sensor. A keyboard alternative already exists; this is at most a note.
- `react-beautiful-dnd` or `@hello-pangea/dnd` used with the standard drag
  handle props. Their built-in keyboard dragging counts.
- A `draggable` attribute left on an element with no `dragstart` and no `drop`
  handler anywhere. Dead code, not a failure.
- Native `input type="range"`, native scrollbars, native text selection - user
  agent behaviour the author has not replaced.
- A component that also renders move up and move down buttons, even when they
  are less convenient than dragging.
- Drawing, painting and signature surfaces where the drag path is the content.

---

## Reporting rules for this group

- One finding per component per criterion. A board that is drag-only for
  reordering and swipe-only for changing column is a 2.5.7 finding and a 2.5.1
  finding, each with its own `sourcePath`.
- `sourcePath` is mandatory and must be a repository-relative path with a line
  number, such as `components/Carousel.tsx:48`. Point at the handler or the
  configuration line, not at the top of the file. Never guess a path, never
  reconstruct one from an import, and never report a component whose source you
  were not given. No path, no finding.
- `detail` must record the search for the alternative, not just the handler.
  Name the files and lines you read, the props and sensors you checked, and
  what was absent. "Uses sortablejs" is not a finding. "sortablejs is
  initialised at `components/PriorityList.tsx:31`; the list item at lines 58 to
  74 renders only a label and a remove button, there is no move up or move down
  control, no overflow menu, and no keyboard handling is added around the
  library" is.
- Severity follows what the user cannot do. `critical` where the drag or
  gesture is the only route through a required step. `serious` where a real
  function is unreachable without dragging but the task can be completed
  another way. `minor` where the function is peripheral or duplicated
  elsewhere.
- Verdict policy for this lane: `verdict` is always FLAG, on every finding,
  however clear the source reads. The schema accepts nothing else, so a
  confident DECIDE wastes the pass. If the source you were given does not let
  you check for an alternative, do not file the finding at all.
