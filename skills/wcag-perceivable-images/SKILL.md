---
name: wcag-perceivable-images
description: Judging images against WCAG 1.1.1 Non-text Content and 1.4.5 Images of Text - is the alternative text accurate rather than merely present, and is text baked into a raster image. Load when auditing img, inline SVG, canvas, CSS background imagery, icon fonts, charts, or any picture that carries information.
---

# Images and non-text content

Two criteria. Both are decided by looking at the picture and then at what the
markup says about it. The gap between the two is the finding.

Lane: VIS. Both criteria are DECIDE.

---

## 1.1.1 Non-text Content - Level A

### What the standard requires

Every non-text element that conveys information must have a text alternative
that serves the **equivalent purpose**. Not a label. Not a filename. The same
information, delivered in text.

The standard names five categories and they are judged differently:

| Category | Requirement |
|---|---|
| Informative image | Alternative conveys the same information |
| Decorative image | Removed from the accessibility tree entirely |
| Functional image (sole content of a link or button) | Alternative names the **destination or action**, not the picture |
| Complex image (chart, diagram, map) | Short alternative plus a long description available in text |
| CAPTCHA / test / sensory | Alternative identifies the purpose, and an alternative form exists |

### How to test it

1. List every image-bearing node: `img`, inline and sprited `svg`, `canvas`,
   `object`, `input type="image"`, `role="img"`, icon-font spans, and CSS
   `background-image` on elements that carry meaning.
2. For each, read the accessible name the tree actually computes - `alt`,
   `aria-label`, `aria-labelledby`, `title` inside SVG, or fallback text. Do
   not read the `alt` attribute in the source and stop there; an `aria-label`
   on the same element overrides it.
3. Decide the category from what you see in the screenshot, then ask that
   category's question:
   - Informative: **cover the image. Does the rest of the page still tell me
     what the image told me?** If not, the alternative must carry it.
   - Functional: **if I could not see this, would I know where activating it
     takes me?** A magnifier icon that is the whole content of a search
     submit button must be named "Search", not "magnifying glass".
   - Complex: **does the alternative contain the numbers, the trend or the
     relationship the diagram shows?** A bar chart's alternative must give
     the values, or point at a data table that does.
4. For decorative images, confirm they are actually removed: `alt=""` with no
   `title`, or `role="presentation"` / `aria-hidden="true"`. An empty `alt`
   with a non-empty `title` is still announced.

### Genuine failure

- `alt="image"`, `alt="photo"`, `alt="icon"`, `alt="graphic"`, `alt="banner"`.
- `alt="hero-banner-final-v2.png"` or any filename, hash or CMS asset id.
- An `img` with no `alt` attribute at all inside an `a`: assistive technology
  falls back to announcing the URL.
- An inline `svg` used as a button's only content with no `title` element and
  no `aria-label` on the button.
- A chart image whose alternative is "Sales chart" while the page nowhere
  states the values the chart plots.
- A `div` with a meaningful CSS `background-image` and no text equivalent
  anywhere - a status badge rendered entirely as a background sprite, say.
- Icon-font spans such as `i class="fa fa-trash"` as the only content of a
  control, so the control announces as bare "button".
- `alt=""` on an image that is the only content of a link.

### False positive - do not report

- A purely decorative divider, spacer, texture or corner flourish with
  `alt=""`. That is correct, not a failure.
- An icon sitting **beside** visible text inside the same control, where the
  icon is `aria-hidden="true"`. The control already has a name and the icon
  must not repeat it.
- A logo whose alternative is the organisation name. That is the correct
  alternative; do not demand a description of the logo's shapes.
- A long alternative. Length is not a failure, inaccuracy is. Never report
  "alt text is too verbose".
- An image whose alternative duplicates an adjacent caption **when the image
  is marked decorative**. Duplication is only a failure when both are exposed.
- A tracking pixel or 1x1 spacer with `alt=""`.
- CAPTCHA images. They fail 1.1.1 only when the alternative does not identify
  the purpose. The cognitive difficulty of the puzzle itself is 3.3.8.

### What to write in `detail`

Name the element, quote the current accessible name, and **state what the
alternative should have said**. Example: "The chart at `#revenue-chart` has
alt=\"chart\"; a blind user gets none of the four quarterly figures the bars
show (Q1 1.2M, Q2 1.4M, Q3 1.1M, Q4 1.9M)."

---

## 1.4.5 Images of Text - Level AA

### What the standard requires

Text must be delivered as text, not as pixels, wherever the same visual
presentation can be achieved with real text. Two exemptions only:
**customisable** images of text (the user can set font, size and colour) and
**essential** images of text - logotypes and brand wordmarks, and cases where
a specific rendering is the content itself.

### How to test it

1. Scan the screenshot for text that does not select, does not reflow and does
   not change with the page font. Headings, promotional banners, pricing
   tables, infographics and navigation are the usual offenders.
2. Cross-check the accessibility tree. Text you can see in the image but
   cannot find as a text node in the tree is a candidate.
3. Zoom to 200%. Real text re-renders crisply; rasterised text blurs or
   pixelates. This is the single most reliable tell.
4. Ask the exemption question: **is the exact rendering essential, or is it
   styling somebody did in a graphics editor?** Gradients, custom fonts,
   letter spacing and drop shadows are all achievable in CSS and are
   therefore not essential.

### Genuine failure

- A promotional banner where headline, body copy and call to action are all
  baked into a JPG or PNG.
- A pricing or comparison table rendered as one image.
- Navigation items rendered as image buttons with the label in the bitmap.
- An infographic carrying paragraphs of body copy as pixels.
- A "quote of the day" card rendered server-side to PNG.

### False positive - do not report

- A logo or brand wordmark. Explicitly exempt.
- Text inside a photograph of the real world - a street sign, a book cover, a
  product shot with packaging copy.
- A screenshot used as a screenshot: documentation, a bug report, a UI tour.
- Text rendered as SVG `text` elements. That is real, selectable, scalable
  text and it is not an image of text.
- Text rendered with a webfont, however unusual the font. A webfont is text.
- Labels inside charts and graphs. Those are governed by 1.1.1, not 1.4.5.
- Mathematical notation or sheet music where the rendering is the content.

### What to write in `detail`

Quote the text that is trapped in the image and say which region of the
screenshot it is in. Example: "The hero at the top of the viewport renders
'Apply for housing support in under 10 minutes' as part of hero-banner.png;
the string appears nowhere in the accessibility tree and blurs at 200% zoom."

---

## Reporting rules for this group

- One finding per element per criterion. An image that is both an unlabelled
  functional icon (1.1.1) and a bitmap of text (1.4.5) produces two findings.
- Severity is about the user's task. A missing alternative on the submit
  button of the only form on the page is `critical`. A missing alternative on
  a decorative-adjacent thumbnail in a footer is `minor`.
- Never report an image you did not actually see in a screenshot or find in
  the tree you were given. No selector, no finding.
