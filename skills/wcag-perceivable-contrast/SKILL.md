---
name: wcag-perceivable-contrast
description: Judging colour used as the only visual cue (1.4.1), the 3 to 1 contrast required of user-interface boundaries and meaningful graphics (1.4.11), and flashing content (2.3.1) - load when auditing links in body text, error and required states, focus rings, input borders, toggles, icons, charts, or animated content that blinks, and never for text contrast 1.4.3 which the in-application TREE library measures.
---

# Colour, non-text contrast and flashing

Three criteria, one question. Can somebody who does not separate hues, who
cannot resolve a low-contrast edge, or who reacts to flashing still use this
page. All three are answered from rendered pixels, not from markup.

Lane: VIS. All three criteria are DECIDE.

**1.4.3 Contrast (Minimum) is not in this skill and must never be reported from
this lane.** Text contrast is measured by the in-application TREE library from
computed styles, which beats any impression formed from a screenshot. If text
looks too pale to you, say nothing here. A duplicate reaches the ledger as a
second finding on the same element.

---

## 1.4.1 Use of Color - Level A

### What the standard requires

Colour must not be the **only** visual means of conveying information,
indicating an action, prompting a response, or distinguishing one element from
another. Nothing here is about ratios: two vividly different hues at 7:1 still
fail when hue is all there is. The second cue must exist at rest, without hover
or focus - shape, an icon, underline, weight, position, border style, a pattern
fill, or plain text.

### How to test it

1. List every place colour carries meaning: links in running text,
   required-field markers, validation states, status badges, chart series and
   legends, calendar availability, diff highlighting, map keys, the current step
   of a progress indicator.
2. Read each as though the screenshot were greyscale. If two things collapse
   into the same grey, hue was carrying the distinction alone.
3. Name the second cue. If you cannot name it, that is the finding.
4. Links in body text are the special case. Colour alone is permitted only when
   the link colour reaches 3:1 against surrounding body text **and** a further
   cue appears on hover and focus. That needs a measured ratio; with no
   measurement, describe what you see and use FLAG.
5. Charts: legend swatches differing only in hue, with no direct labels, marker
   shapes or dash patterns, means the series cannot be told apart.

### Genuine failure

- An `a` inside a paragraph with `text-decoration: none` and no difference in
  weight, size or family from the text around it.
- A required field indicated only by a red label - no asterisk, no "(required)",
  no instruction saying red means required.
- An invalid field shown only by `border-color: #d33`, with no message text, no
  icon and no change of border style.
- A five-series line chart separated only by stroke colour, with a colour-swatch
  legend and no direct labels.
- A status column where paid rows are green and overdue rows red, with the same
  word or no word in the cell.

### False positive - do not report

- Text that looks too pale. That is 1.4.3 and it belongs to TREE.
- A link underlined at rest whose underline is removed on hover. The resting
  state carries the cue, which is where the requirement bites.
- A red border **plus** "Enter a valid postcode". Redundant colour is correct.
- A red asterisk beside a label. An asterisk is a shape, not a colour.
- Colour carrying no information - brand palette, section tints, a photograph.
- A chart whose lines are labelled at their ends, or whose markers differ in
  shape, even when the colours differ too.
- A disabled control in a lighter tone. Inactive components are exempt and the
  state is exposed programmatically; where it is not, that is 4.1.2.

---

## 1.4.11 Non-text Contrast - Level AA

### What the standard requires

3:1 against adjacent colours, for two things:

| Thing | What must reach 3:1 |
|---|---|
| User-interface component | The information needed to identify the component and its state - an input's boundary, a button's edge against the page, a checkbox outline, a toggle track and thumb, a focus indicator |
| Graphical object | Only the parts required to understand the content - an icon's glyph, a chart's line or bar, the lines of a diagram that carry the meaning |

Exempt: inactive or disabled components, appearance determined entirely by the
user agent and not modified by the author, and logotypes.

### How to test it

1. **Trust measured ratios supplied by the application over your own impression
   of the pixels.** A measurement rules whether or not the rendering looks fine.
   With no measurement, describe what you see and use FLAG. Never state a ratio
   you did not measure.
2. For each control ask which pixels say "this is a control" and which say what
   state it is in. A 1px border must reach 3:1 against the page behind it; a
   filled block, the fill against the page.
3. Check both adjacencies of a focus indicator - the ring against the page, and
   against the component it surrounds. Size and obscuring are 2.4.11.
4. For icons, compare the glyph against its own container. On an icon-only
   control the glyph is required to understand the control.
5. For charts, compare each line, bar or slice against the plot background and
   against its neighbours wherever hue is the only separator.

### Genuine failure

- `input` with `border: 1px solid #e0e0e0` on white, around 1.3:1, so the field
  boundary is invisible to a low-vision user.
- A focus ring of `outline: 2px solid #b3d4fc` on white, under 2:1.
- A toggle whose off-state track is `#eeeeee` on white with no border.
- A checkbox drawn as a `#dddddd` hairline square.
- An icon-only button whose glyph is `#cfcfcf` on a white toolbar.
- Pie slices in adjacent pale tints with no separating stroke and no labels.

### False positive - do not report

- Disabled or inactive controls. Explicitly exempt.
- Decorative pixels: gridlines, background patterns, watermarks, drop shadows,
  hairline dividers. Nothing needed to understand the content runs through them.
- A logotype, or an unstyled browser-default `select` or checkbox.
- A link-styled or borderless button where nothing but the label is drawn. There
  is no boundary to measure; the label is 1.4.3 and belongs to TREE.
- Placeholder text, helper text and labels. All 1.4.3.
- A ratio you estimated by eye. With no measurement, FLAG and describe the
  pixels; do not assert a number.

---

## 2.3.1 Three Flashes or Below Threshold - Level A

### What the standard requires

Nothing flashes more than three times in any one second period unless it is
below both thresholds. A flash is a **pair of opposing changes** in relative
luminance. General threshold: opposing changes of 10% or more of maximum
relative luminance, darker state below 0.80, over an area larger than 25% of 10
degrees of the visual field - roughly 341 x 256 px on a 1024 x 768 display at
typical viewing distance. Red threshold: any opposing transition involving a
saturated red, whatever the luminance change. The whole page counts, third-party
embeds and advertising included.

### How to test it

1. Inventory what can flash: `video`, animated GIF, APNG and WebP, `canvas`, CSS
   `animation` or `transition` loops on `opacity`, `background-color`, `filter`
   or `visibility`, autoplaying embeds and ads, strobing loading states.
2. For CSS, do the arithmetic rather than watching. Count opposing luminance
   transition pairs per second from `animation-duration`, `animation-direction`
   and the keyframe stops. A two-stop keyframe at 0.15s is roughly 6.7 per
   second.
3. For video and GIF, sample the flashing area frame by frame: record the mean
   relative luminance of that area per frame, count pairs of opposing changes of
   10% or more of maximum where the darker state sits below 0.80, and report the
   worst one-second window.
4. Measure the flashing area against the threshold. A large swing across a
   40 x 40 px badge is below it; the same swing across the hero is not.
5. Check separately for saturated red transitions, which fail on hue alone.
6. If you cannot obtain frames - DRM, a cross-origin iframe, autoplay blocked -
   do not guess. FLAG with what you observed, or BLOCKED when you observed
   nothing.

### Genuine failure

- A hero video with a strobe sequence exceeding three flashes a second across
  most of the viewport, with no warning and no way to stop it.
- `@keyframes blink { 50% { opacity: 0 } }` at `animation: blink 0.15s infinite`
  on a full-width banner.
- An animated GIF advertisement alternating saturated red and white at speed.
- A prize-draw or game "spin" animation strobing the full viewport.
- A form that flashes the page background red repeatedly on a validation error.

### False positive - do not report

- A slow pulse - a 1 Hz recording dot, a breathing skeleton shimmer.
- A text caret blink.
- A spinner or indeterminate progress bar. The area is far below threshold even
  when the animation is fast.
- A cross-fade, a scroll-triggered fade-in, a hover transition. None are
  opposing luminance flashes.
- Fast-cut video editing with no large luminance swing.
- Parallax, carousels and marquees. Motion that does not flash is 2.2.2 Pause,
  Stop, Hide, owned by another pack.

---

## Reporting rules for this group

- One finding per element per criterion. An input whose border measures 1.3:1 and
  whose error state is signalled only in red produces two findings, 1.4.11 and
  1.4.1.
- Severity follows the user's task. 2.3.1 is `critical` whenever a threshold is
  exceeded - a health risk, not an inconvenience. A colour-only error state on
  the field blocking submission is `critical`. An invisible input boundary on the
  primary form is `serious`. A colour-only status in a supplementary table is
  `moderate`. A pale footer icon is `minor`.
- 1.4.3 is never reported from this lane, at any severity, however obvious.
- Evidence discipline: never invent a selector and never invent a ratio. Quote
  the measurement you were given or say you had none - a guessed number is worse
  than none, because a developer will act on it. Write "the measured ratio
  between the `#e0e0e0` border of `#postcode` and the `#ffffff` field is 1.28:1,
  and that border is the only thing marking the field".
- Verdict: DECIDE when a measurement or the arithmetic settles it. FLAG when
  judging pixels with no measurement, or when you could not sample enough frames.
  BLOCKED when the media or region was unreachable, and say why in `detail`.
