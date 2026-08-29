---
name: wcag-perceivable-adaptable
description: Reproducing and judging the four viewport conditions - 1.3.4 Orientation, 1.4.4 Resize Text at 200%, 1.4.10 Reflow at 320 CSS px and 1.4.12 Text Spacing - load when auditing zoom, narrow viewports, increased line and letter spacing, portrait or landscape locking, or any report of clipped, overlapped or truncated content.
---

# Zoom, reflow, spacing and orientation

Four criteria that cannot be judged from a default screenshot. Each needs the
page put into a specific condition first, then looked at. The steps below are
exact on purpose: an audit saying "text overlaps at high zoom" without the
viewport and the zoom level cannot be verified or fixed.

Lanes: VIS and ACT. Both own all four, and they do different halves of the job.
**ACT reproduces the condition and captures the artefact** - sets the viewport,
applies the zoom or the CSS override, rotates the device, saves a screenshot to
the sandbox and references it by path. **VIS judges the resulting screenshot.**
If you are ACT and cannot reach the condition, report BLOCKED rather than
reasoning about what would probably happen. If you are VIS and were handed no
artefact taken under the condition, do not rule from the default screenshot.

All four criteria are DECIDE.

---

## 1.4.4 Resize Text - Level AA

### What the standard requires

Text must scale to 200% with no loss of content or functionality and without
assistive technology. Loss of content is text clipped, truncated, hidden behind
other content or pushed outside its container. Loss of functionality is a
control that can no longer be reached or activated. Captions and images of text
are excluded.

### How to test it

1. Set the viewport to 1280 x 1024 at device pixel ratio 1.
2. Apply **text-only** zoom to 200%. Page zoom is a different criterion. Where
   the browser offers no text-only zoom, reproduce it by doubling the root font
   size and say in `detail` that you did:
   ```css
   html { font-size: 200% !important; }
   ```
   A page sized entirely in `px` will not respond at all, and that
   non-response is itself the finding.
3. Screenshot the full page, then each dense region - navigation, cards, tables,
   buttons, form labels, validation messages.
4. Look for text clipped by a fixed `height` or `max-height`, `overflow: hidden`
   cutting a string mid-word, ellipsis truncation, labels spilling outside their
   background, overlapping blocks, content pushed under a sticky header.
5. Confirm every control still works: nothing off-screen, nothing trapped under
   a fixed overlay.

### Genuine failure

- A primary button with `height: 40px; overflow: hidden` whose label is sliced.
- Navigation items overlapping each other and becoming unclickable.
- A card grid with `max-height` per card, cutting the last line of body copy.
- A validation message truncated to "Enter a valid pos..." with no way to read
  the rest.
- A modal with a fixed pixel height whose action buttons scroll out of reach.
- Labels overlapping their inputs so the field cannot be identified.
- A page that ignores text size entirely because every size is `px` in a fixed
  layout, so a user needing larger text gets none.

### False positive - do not report

- Vertical scrolling appearing or increasing. That is the expected result of
  larger text, not loss of content.
- A responsive layout switching to its mobile arrangement at 200%. Reflow is
  correct behaviour.
- Longer wrapping, ragged edges, an orphan or a widow. Aesthetic, not content
  loss.
- Images not scaling with the text. This criterion covers text.
- Captions over video, and images of text. Both excluded.
- A data table gaining its own horizontal scrollbar while the page does not.

---

## 1.4.10 Reflow - Level AA

### What the standard requires

Content must be presentable with no loss of information or functionality, and
without scrolling in **two dimensions**, at 320 CSS px wide for vertically
scrolling content and 256 CSS px tall for horizontally scrolling content.
Vertically scrolling content must not also require horizontal scrolling, and the
reverse. The exception is content genuinely requiring a two-dimensional layout.

### How to test it

1. Reproduce it either way - the two are equivalent:
   - viewport **320 x 256 CSS px**, or
   - viewport **1280 x 1024** with **400% page zoom**.

   Use `deviceScaleFactor: 1` and do not enable mobile emulation, which can serve
   a different page and hide the failure.
2. Load, wait for layout to settle, screenshot the full page.
3. Test for horizontal scroll by measurement, not by eye: compare
   `document.documentElement.scrollWidth` against `window.innerWidth`. More than
   a rounding pixel of difference is the failure.
4. Identify the element causing the overflow - a fixed `width` in px, a
   `min-width`, a wide image, a long unbroken string, an absolutely positioned
   panel.
5. Check that nothing was **lost** rather than merely rearranged. Navigation
   collapsed into a menu button is fine when the menu opens with the same items.
6. Open every disclosure, menu and dialog at this width. A dialog wider than the
   viewport fails even when the page behind it is clean.

### Genuine failure

- `min-width: 1024px` on a wrapper, forcing the document to scroll sideways.
- A fixed 280px sidebar pushing the main column off-screen.
- A pricing layout on fixed pixel grid columns that overflows and is not a data
  table.
- A long unbroken string - an API key, a URL - with no `overflow-wrap`, extending
  the document's scroll width.
- A cookie banner or chat widget with a fixed width wider than the viewport.
- A form whose inputs carry `width: 400px`.
- A modal dialog overflowing horizontally while the page beneath reflows.

### False positive - do not report

- A **data table** scrolling horizontally inside its own container. The
  archetypal two-dimensional exception.
- A map, a seating plan, a circuit or org diagram, or an image the user is meant
  to inspect in detail.
- Video and its transport controls.
- A toolbar in a code editor or similar authoring interface, where the
  two-dimensional arrangement is required for use.
- Navigation collapsing into a menu button, when the menu opens and nothing is
  lost.
- Content behind a working "Show more" control at narrow widths.
- A one or two pixel `scrollWidth` overhang from rounding or a scrollbar.
  Confirm the overflow is real before reporting it.

---

## 1.4.12 Text Spacing - Level AA

### What the standard requires

No loss of content or functionality when the user overrides text spacing to at
least line height 1.5 times the font size, spacing after paragraphs 2 times the
font size, letter spacing 0.12 times the font size, and word spacing 0.16 times
the font size. The page need not apply these values. It must survive them.

### How to test it

1. Load at 1280 x 1024 and inject exactly this override, which is the
   bookmarklet the criterion is written around:
   ```css
   * {
     line-height: 1.5 !important;
     letter-spacing: 0.12em !important;
     word-spacing: 0.16em !important;
   }
   p, li, dd, blockquote {
     margin-bottom: 2em !important;
   }
   ```
2. Wait for layout to settle, then screenshot the full page and each dense
   region.
3. Compare against the same regions before the override, looking for three
   things and only these three: **clipping**, **overlap** and **truncation**.
4. Inspect the usual victims: fixed-height buttons, single-line nav items,
   badges and pills, table cells, tab strips, titles capped with
   `-webkit-line-clamp`, containers with `height` rather than `min-height`.
5. Confirm the override applied. Text that did not move at all usually means the
   injection was blocked by specificity or a Shadow DOM boundary - say so rather
   than reporting a pass.

### Genuine failure

- A button with `height: 36px` whose label clips top and bottom at line height
  1.5.
- Navigation items wrapping inside a fixed-height bar and being cut off.
- A card title with `-webkit-line-clamp: 2` now hiding essential text.
- Table cells whose content overlaps the row beneath.
- A badge whose text overflows its rounded background into neighbouring text.
- A fixed-height footer whose last row of links is cut off.
- A tab strip whose labels overlap and become unclickable.

### False positive - do not report

- The page becoming taller, or more vertical scrolling.
- Lines wrapping differently, or a heading breaking across two lines.
- Ugly spacing, uneven columns, changed rhythm. Aesthetics are out of scope.
- Text spilling only into whitespace belonging to nothing else.
- Slight overlap of a decorative element - a flourish, a divider.
- Content inside a `canvas` or an image, which the override cannot reach.
- A page whose own line height already exceeds 1.5. That is compliance.

---

## 1.3.4 Orientation - Level AA

### What the standard requires

Content must not restrict its view and operation to a single display
orientation, portrait or landscape, unless a specific orientation is
**essential**.

### How to test it

1. Load in portrait at 390 x 844 CSS px, then in landscape at 844 x 390 CSS px.
   Screenshot both.
2. Look for an explicit lock in the CSS - an
   `@media screen and (orientation: portrait)` block used to hide content or show
   a "please rotate your device" interstitial, or a `transform: rotate(90deg)`
   applied to the whole page.
3. Check the web app manifest for `"orientation": "portrait"` or `"landscape"`,
   and the source for `screen.orientation.lock()`.
4. In each orientation confirm the same content and controls are present and
   operable. Rearranging is fine; removing content or refusing to render is not.
5. Where a lock exists, apply the essential test before ruling either way.

### Genuine failure

- A "Please rotate your device to portrait" interstitial blocking content in
  landscape.
- A manifest declaring `"orientation": "portrait"` for an ordinary content or
  transactional site.
- `screen.orientation.lock("landscape")` called on load.
- Landscape CSS hiding the main navigation entirely, so a user with a
  wheelchair-mounted device fixed in landscape cannot navigate.
- A checkout step that renders its payment form only in portrait.

### False positive - do not report

- A layout that simply reflows between orientations. That is the requirement
  working.
- A genuinely essential orientation: a piano or fretboard app, a cheque or
  document capture step where the frame must match the object, a virtual reality
  or 360 view.
- Full-screen video playing in landscape when the user chose full-screen.
- An orientation-specific layout offered as a preference the user can override.
- A device or operating system rotation lock. Outside the page's control.

---

## Reporting rules for this group

- One finding per element per criterion. A fixed-height button that clips at 200%
  zoom and clips again under the spacing override produces two findings, 1.4.4
  and 1.4.12. Do not merge them into "the button breaks under adaptation".
- Always state the condition you reproduced, in numbers: viewport in CSS pixels,
  zoom percentage, the override applied, the orientation. A finding without its
  condition cannot be reproduced and will be closed as unverifiable.
- Severity follows the user's task. Content lost from the primary flow - a submit
  button unreachable at 320px, a payment form that will not render in landscape -
  is `critical`. A clipped validation message is `serious`. A truncated card
  title in a marketing grid is `moderate`. A clipped footer link is `minor`.
- Evidence discipline: reference the screenshot you actually captured by its
  sandbox path and name the CSS declaration causing the failure when you have the
  styles. Never invent a selector, and never describe a condition you did not
  reproduce.
- Verdict: DECIDE when the artefact taken under the condition shows the loss.
  FLAG when the override plainly did not apply, when only part of the page could
  be captured, or when the essential-orientation judgement is arguable. BLOCKED
  when the condition could not be reached - zoom refused, the viewport could not
  be set, the page would not load at 320px - and say which in `detail`.
- ACT never rules from imagination and VIS never rules from the default
  screenshot. With no artefact for the condition, there is no finding to make.
