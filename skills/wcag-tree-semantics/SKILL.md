---
name: wcag-tree-semantics
description: The nine WCAG criteria AccessiFix decides from markup, computed style and the accessibility tree alone - 1.3.3, 1.3.5, 1.4.3, 2.4.2, 2.4.4, 2.4.6, 2.5.8, 3.1.1 and 3.1.2. Load when writing or reviewing the TREE library's rules, or when a human is checking what TREE reported.
---

# Criteria decidable from the DOM and accessibility tree alone

Nine criteria, each settled by reading markup, computed style and the accessibility
tree. No screenshot, no interaction, no repository.

Lane: TREE. All nine are DECIDE.

TREE is not a TrueForge agent. It is a library inside the AccessiFix application -
axe-core plus a direct read of the accessibility tree - and it calls no model. This
skill is the reference for that library's rules and for the human reviewers who read
what it reports. No auditing agent mounts it, and no agent may report these nine
criteria: they belong to the application, and every audit lane's schema excludes them.

---

## 1.3.3 Sensory Characteristics - Level A

### What the standard requires

Instructions must not rely solely on shape, colour, size, visual location, orientation
or sound. The test is additive: "Click the round button on the right" fails; "Click the
round Submit button on the right" passes, because the name is also given.

### How to test it

1. Extract instructional strings - click, select, press, choose, enter, tick, see, use.
2. Match against the sensory vocabulary: round, square, large, small, on the right,
   above, below, in the sidebar, red, green, in landscape, after the beep.
3. Ask whether the same sentence also gives a non-sensory identifier, then resolve it
   against the tree. "Click Submit" passes only if a control named Submit exists.

### Genuine failure

- "Click the round button on the right to continue."
- "Fields shown in red are required." (Colour alone also fails 1.4.1, another lane's.)
- "Press the button below the map."
- "Use the menu on the left", where that navigation has no name and no heading.

### False positive - do not report

- "Click the round Submit button on the right." The name is present.
- "Fields marked with an asterisk (*) are required." An asterisk is text.
- "See the table below" where the table follows in DOM reading order.
- Descriptive prose that instructs nobody, and colour named alongside text carrying
  the same distinction.

---

## 1.3.5 Identify Input Purpose - Level AA

### What the standard requires

An input collecting information about the user must carry the correct `autocomplete`
token from the WCAG input-purpose list - `name`, `given-name`, `email`, `tel`,
`street-address`, `postal-code`, `country-name`, `username`, `current-password`,
`cc-number`, `cc-exp`, `bday`, `url` and the rest of the 53. Both conditions are
required: the field is about the user themselves, and the token is the right one.

### How to test it

1. Read each control's accessible name, `type`, `name` attribute and enclosing legend,
   and decide whether it collects the user's own data. Only those are in scope.
2. Strip any legal prefix - `section-*`, `shipping`, `billing`, `home`, `work`,
   `mobile` - then check the remaining token against the list.
3. Compare the token against what the field actually asks for. `autocomplete="on"`
   and `autocomplete="off"` are not purpose tokens and both fail in scope.

### Genuine failure

- A checkout form taking the user's name, email, address and card number with no
  `autocomplete` anywhere.
- `autocomplete="off"` on the user's own email field.
- `autocomplete="cc-number"` on the expiry field, or `autocomplete="name"` on a field
  labelled "Date of birth", where `bday` is correct.
- A token not on the list, such as `autocomplete="fullname"`.

### False positive - do not report

- A search box. It collects a query, not information about the user.
- "Recipient's name", "Deliver to", "Friend's email" - fields about a third party.
- Quantity, subject line, message body, product code, promotional code.
- `autocomplete="one-time-code"`, and prefixed tokens such as
  `autocomplete="section-billing postal-code"`. Both correct.

---

## 1.4.3 Contrast (Minimum) - Level AA

### What the standard requires

4.5:1 for normal text, 3:1 for large text, where large means 18pt / 24px, or 14pt /
18.66px bold. Exempt: incidental text, inactive components, pure decoration, invisible
text, and logotypes.

### How to test it

The measured ratio is the evidence, never an impression of the pixels.

```
c_lin = c / 12.92                        when c <= 0.03928
c_lin = ((c + 0.055) / 1.055) ** 2.4     otherwise

L = 0.2126 * r_lin + 0.7152 * g_lin + 0.0722 * b_lin
ratio = (L_lighter + 0.05) / (L_darker + 0.05)
```

1. Resolve the computed foreground, compositing alpha over what is behind it.
2. Resolve the background by walking ancestors to the first opaque paint. A transparent
   parent is not the background.
3. Read `font-size` and `font-weight` to pick the threshold, then record the ratio to
   two decimals, both hex colours, and which threshold applied.

Gradients and background images: sample under the text at several points and evaluate
the worst one. Text reaching 6:1 over the light end of a gradient and 2.1:1 over the
dark end fails, and the failing sample is the evidence. Text over a photograph: sample
the image region behind each glyph run and take the worst ratio, compositing any scrim
over the photo first. An image that cannot be sampled is not a pass - it is out of
TREE's reach and belongs to the vision lane.

### Genuine failure

- Helper text at `#9E9E9E` on `#FFFFFF`, which measures 2.85:1.
- Text styled to look disabled on a control that is genuinely active.
- 16px white heading text over the pale end of a hero gradient.
- 17px bold white on `#7FB2E5`. It clears 3:1, but 17px bold is under the 18.66px
  threshold, so 4.5:1 applies and it fails.

### False positive - do not report

- Text inside a genuinely disabled control, and logotypes, whatever they measure.
- Text with `visibility: hidden`, `display: none` or zero opacity.
- A fail produced by sampling an anti-aliased glyph edge. Measure the glyph core.
- Icons, borders and control boundaries. Non-text contrast is 1.4.11.

---

## 2.4.2 Page Titled - Level A

### What the standard requires

A `title` element that is present, non-empty, and describes the topic or purpose of
the page. Across a page set, titles distinguish one page from another.

### How to test it

1. Read the title after render, not from static HTML. A single-page application that
   sets it on route change is judged on the settled value.
2. Assert it is non-empty, not whitespace only, and names the page's own topic rather
   than only the site.
3. Compare it against the titles of the other pages in the crawl set.

### Genuine failure

- No `title`, or one containing only whitespace.
- `Untitled`, `Document`, `React App`, `index`, `New Page`.
- Every page titled with the organisation name alone, so no topic appears anywhere.
- Two different pages sharing an identical title in the same crawl set, or an
  unresolved template placeholder such as `%s | Site Name`.

### False positive - do not report

- A long title. Length is not a failure.
- The site name appended after the topic, which is correct and conventional.
- A title identical to the `h1`. Duplication is not a failure.
- A title written in the page's declared language rather than English.

---

## 2.4.4 Link Purpose (In Context) - Level A

### What the standard requires

Link purpose is determinable from the link text alone, or from the link text plus its
programmatically determined context: the sentence, paragraph, list item or table cell
containing it, an associated header cell, or content nested inside the link. A heading
above the link is not context here; it counts only via `aria-labelledby`.

### How to test it

1. For every `a` with an `href`, compute the accessible name, including any visually
   hidden span nested inside it.
2. If the name alone settles the destination, stop. Otherwise take the containing
   paragraph, list item or cell and ask whether name plus context settles it.
3. Group links by name; where a name repeats, check whether each instance has distinct
   context and whether they point at different targets.

### Genuine failure

- "Read more" twelve times in a flat sequence of `div` elements, each article title in
  a sibling container rather than in the same list item or paragraph.
- "Click here", "More", "Details", "Link" with nothing distinguishing them.
- An icon-only link with no accessible name, which announces as the bare URL.
- Two links with identical text and identical context going to different destinations.

### False positive - do not report

- "Read more" inside an `li` that also holds the article heading. The list item is
  context, so it passes. Standing alone unaided is 2.4.9, which is AAA.
- Repeated identical link text pointing at the same destination.
- A link whose text is a full URL. Ugly, determinable, not a failure.
- "Home", "Contact", "Terms" - short is not vague - and any link named by
  `aria-labelledby` pointing at a nearby heading.

---

## 2.4.6 Headings and Labels - Level AA

### What the standard requires

Headings and labels, where used, describe topic or purpose. This is about the quality
of the text, not whether it exists and not how it nests. A missing label is 3.3.2; a
skipped heading level, or a visual heading not marked up as one, is 1.3.1.

### How to test it

1. Collect every `h1` to `h6` and every `role="heading"` element, and read the text
   each actually exposes.
2. Collect every form control's accessible name.
3. Ask whether someone skimming a list of only these strings would know what the
   section or field is for.

### Genuine failure

- An empty heading, or one containing only an image with an empty alt.
- `h1` wrapping the site logo, so the top-level heading is the company name on every
  page of the site.
- Headings reading `Section 1`, `Section 2`, `Untitled`.
- Labels reading `Field 1`, `Input`, `Text`, `Value`.

### False positive - do not report

- Short headings. "Overview", "Fees", "Contact" all describe their topic.
- Duplicate heading text across parallel sections. Uniqueness is not required here.
- A heading level skip, or a `div` styled to look like a heading. That is 1.3.1.
- A terse but accurate label such as "DOB" on a clinical intake form, and sentence
  case rather than title case.

---

## 2.5.8 Target Size (Minimum) - Level AA

### What the standard requires

Pointer targets are at least 24 by 24 CSS pixels, with five exceptions:

| Exception | Condition |
|---|---|
| Spacing | A 24px circle centred on the target overlaps no other target |
| Inline | The target sits in a sentence, or in a line of non-target text |
| User agent | The size comes from the user agent and the author has not changed it |
| Essential | A specific size is essential or legally required |
| Equivalent | Another control on the page does the same job at 24 by 24 |

### How to test it

1. Take the bounding box of the whole clickable area - padding and pseudo-element hit
   areas included, not the icon glyph. If both dimensions reach 24, it passes.
2. Otherwise apply spacing. Two 24px circles stop overlapping exactly when their
   centres are 24 CSS pixels apart:

```
passes spacing when distance(centre_a, centre_b) >= 24

two 20x20 targets in a row  ->  gap must be >= 4px
two 16x16 targets in a row  ->  gap must be >= 8px
```

3. Only then consider inline, user agent, essential and equivalent.

### Genuine failure

- A row of 16 by 16 social icons with 2px gaps, so the centres are 18px apart.
- A 20 by 20 modal close button with another control 10px away.
- Pagination numbers rendered at 18 by 18 with no padding, tightly packed.
- A custom checkbox drawn as a 14 by 14 `span` with the native input hidden. The
  author chose that size, so the user-agent exception does not apply.

### False positive - do not report

- A link inside a paragraph of prose. Inline is exempt, however small.
- A native `select` and its options at their default size.
- A 20 by 20 icon button standing alone with 30px of clear space around it.
- A pin on a map, where position is the content. Essential.
- An 18px glyph inside a control whose padded hit area measures 44 by 44.

---

## 3.1.1 Language of Page - Level A

### What the standard requires

The `html` element carries a `lang` attribute whose value is a well-formed BCP 47 tag
matching the language the page is actually written in.

### How to test it

1. Read `lang` off the root element of the rendered document.
2. Assert the primary subtag is a real ISO 639 code and any region subtag is real.
3. Compare the declared language against the language of the body text.

### Genuine failure

- No `lang` on `html`, or an empty `lang`.
- `lang="english"`, `lang="eng-uk"`, `lang="us"`. None are well-formed tags.
- `lang="en"` on a page whose content is in French.
- Only `xml:lang` present in an HTML5 document, or `lang` on `body` only.

### False positive - do not report

- Casing. `lang="EN-gb"` is valid; BCP 47 is case-insensitive.
- `lang="en-US"` on a page using British spelling. The language is still English.
- `lang` repeated on `body` with the same value. Redundant, not wrong.
- An uncommon but valid tag such as `cy`, `gd` or `zh-Hant`.

---

## 3.1.2 Language of Parts - Level AA

### What the standard requires

Any passage or phrase in a language other than the page language carries its own
`lang`. Four exemptions: proper names, technical terms, words of indeterminate
language, and words that are part of the vernacular of the surrounding text.

### How to test it

1. Read the page language from `html`, then walk the text nodes for runs in a
   different language.
2. For each run, find the nearest ancestor carrying `lang` and check the value against
   the run's actual language.
3. Apply the four exemptions before reporting anything. The most reliable finding here
   is a language switcher, where each option renders in its own language - "Deutsch",
   "Francais", "Polski" - and each needs its own `lang`.

### Genuine failure

- A full paragraph of Spanish inside an English document, unmarked.
- A language switcher listing endonyms with no per-item `lang`.
- A blockquote in German with no `lang="de"`.
- A bilingual page where the second-language column inherits the page `lang`, and any
  wrapper whose `lang` names a different language from its content.

### False positive - do not report

- Borrowings that are part of the surrounding vernacular - "rendezvous", "cafe",
  "schadenfreude", "per se", "et al.", "vice versa".
- Proper names: a place, an institution, a person.
- Technical terms with no equivalent in the page language, such as "sushi" or a Latin
  taxonomic name.
- Code samples, identifiers and file names, and single words of indeterminate language.

---

## The two BLOCKED criteria

Two of the 55 reach no lane at all, and a reviewer needs to know why nothing is ever
reported against them.

- 1.2.4 Captions (Live), Level AA. Auditing live captions needs a live stream that is
  actually running. There is nothing to observe on a page that is not broadcasting,
  and a scheduled broadcast cannot be waited for inside a run.
- 3.3.4 Error Prevention (Legal, Financial, Data), Level AA. Establishing that a
  submission is reversible, checked or confirmable would require completing a real
  legal or financial transaction against a live system. That is approval-gate
  territory, not automation.

BLOCKED is reported as blocked. Never as a pass, and never quietly omitted - a report
that leaves these two out claims coverage the run does not have. The verdict enum
removes DECIDE for both, so no lane can rule on them by accident.

---

## Reporting rules for this group

- One finding per element per criterion. A link that is both unnamed (2.4.4) and below
  24 by 24 (2.5.8) produces two findings.
- Every finding names its node with a CSS selector. No selector, no finding.
- Quote the measured value, never the impression: the ratio and both hex colours for
  1.4.3, the box and centre-to-centre distance for 2.5.8, the attribute verbatim for
  1.3.5, 3.1.1 and 3.1.2.
- Severity is about the user's task. An unnamed link in the primary flow is `critical`;
  the same link in a footer is `minor`.
