---
name: wcag-perceivable-structure
description: Comparing what the screenshot shows against what the accessibility tree exposes, for 1.3.1 Info and Relationships, 1.3.2 Meaningful Sequence, 2.5.3 Label in Name and 3.3.2 Labels or Instructions - load when auditing headings, lists, tables, form layouts, grouped controls, reading order, or any control whose visible text may differ from its accessible name.
---

# Visible structure versus programmatic structure

This is the compare-the-screenshot-to-the-tree group. Every finding has the same
shape: something is obvious to a sighted user from position, size, weight or
proximity, and none of it reached the markup. Write down the structure you see
in the image first, then read the tree and find out how much survived.

Lane: VIS. All four criteria are DECIDE. You need both artefacts to rule - with
a screenshot and no tree excerpt you can describe what you see but cannot say
what the markup claims, so use FLAG.

---

## 1.3.1 Info and Relationships - Level A

### What the standard requires

Information, structure and relationships conveyed through presentation must be
programmatically determinable or available in text. Every grouping a sighted
user reads from position, weight, proximity or a drawn box must also exist in
markup: headings, lists, tables, form groupings, label-to-field association and
error-to-field association.

### How to test it

1. From the screenshot alone, write the outline you see - which text acts as a
   heading and at what level, which items form a list, which cells form a table
   with row and column headers, which controls sit under a shared caption.
2. Read the same regions in the tree. Headings must be `h1` to `h6` or
   `role="heading"` with `aria-level`; lists `ul`, `ol` or `dl`; tables `table`
   with `th` carrying `scope`; groups `fieldset` with `legend` or a named
   `role="group"` or `role="radiogroup"`.
3. Check every field has a programmatic label - `label` with `for`, a wrapping
   `label`, `aria-label` or `aria-labelledby` - and that error text is tied to
   its field with `aria-describedby` rather than merely printed beneath it.
4. Check heading levels for skips and for cosmetic use. A `h4` chosen because it
   looked the right size breaks the outline.
5. Read the landmarks - `header`, `nav`, `main`, `aside`, `footer` or the roles.
   A page that is one `div` gives no way to navigate the regions you can see.

### Genuine failure

- `div class="section-title"` styled 28px bold above a block of content, acting
  as a heading, with no heading semantics.
- A visual list rendered as sibling `div` elements with pseudo-element bullets.
- A data table built from `div class="row"` and `div class="cell"`, so no row or
  column relationship exists.
- A `table` whose header row uses `td`, or whose `th` carry no `scope`.
- A "Contact preference" radio set under a bold caption with no `fieldset`,
  `legend`, `role="radiogroup"` or `aria-labelledby`.
- Text positioned above a field as its label with no `for` and no
  `aria-labelledby` - the association is only spatial.
- An error message under a field with no `aria-describedby`.

### False positive - do not report

- **A `div` with `role="heading"` and a correct `aria-level`. That is a
  heading.** Not idiomatic, but programmatically determinable, so 1.3.1 is
  satisfied. Do not report it as a failure or as a style preference.
- A list of links marked up as a list with no visible bullet. The bullet is
  presentation; the relationship is what matters.
- A layout table carrying `role="presentation"`.
- A heading level lower than you would have chosen that still nests coherently.
- Visual grouping carrying no information - card shadows, striped rows, spacing.
- `aria-labelledby` pointing at a visually hidden element. Hidden text is still
  programmatic structure.
- A single-column form of correctly labelled fields. Ungrouped fields need no
  `fieldset`.

---

## 1.3.2 Meaningful Sequence - Level A

### What the standard requires

Where the sequence in which content is presented affects its meaning, a correct
reading sequence must be programmatically determinable. The DOM order assistive
technology reads must match the meaningful order a sighted user reads. The
usual causes are CSS reordering that never touches the DOM: `order` on a flex
item, `flex-direction: row-reverse` or `column-reverse`, `grid-row` and
`grid-column` placement, `grid-auto-flow: dense`, absolute positioning, `float`.

### How to test it

1. Read the tree top to bottom and write down the sequence of text and controls
   in the order it presents them.
2. Read the screenshot in visual order - left to right, top to bottom,
   respecting columns.
3. Compare the two lists and note every divergence.
4. For each divergence ask whether the sequence carries meaning. A step before
   its instruction, an answer before its question, a total before the figures it
   sums, a control before the label explaining it - all meaningful.
5. Name the mechanism in the styles so the finding is actionable.
6. Tab order is not this criterion. A control reachable in the wrong sequence by
   keyboard is 2.4.3 Focus Order, which ACT owns.

### Genuine failure

- A three-column pricing table whose DOM order is Standard, Enterprise, Basic
  while `order` renders Basic, Standard, Enterprise, so the tree reads prices in
  a sequence that does not match what a sighted user compares.
- A filter sidebar that appears right of the results but precedes them in the
  DOM, so a screen reader user hears the whole panel before one result.
- A submit button early in the DOM, placed at the bottom with
  `position: absolute`.
- `flex-direction: row-reverse` on a wizard's button row, so "Back" is read
  after "Continue" while appearing before it.
- A footnote whose explanatory text is placed before the passage it annotates.

### False positive - do not report

- **Visually reordered decorative content.** A hero illustration, a flourish or
  a divider moved by CSS changes no meaning, and is not a 1.3.2 failure.
- A responsive reflow whose columns stack sensibly at narrow widths. Different
  from desktop is not the same as meaningless.
- Reordered blocks that read sensibly either way - two independent promo cards.
- A sticky header or floating action button positioned away from its DOM
  location, where its content is self-contained.
- A difference between DOM order and tab order. That is 2.4.3.
- Two columns read one after the other rather than interleaved.

---

## 2.5.3 Label in Name - Level A

### What the standard requires

For a control with a visible text label, the accessible name must **contain**
the visible label text, in the same order. A speech-input user says the words
they read; if those words are not in the accessible name, the command does not
match and the control cannot be operated by voice. Contain, not equal - extra
words are permitted **after** the visible text, and extra words before it break
the match and fail.

### How to test it

1. For every control with visible text - buttons, links, tabs, checkboxes,
   radio buttons, labelled fields, menu items - read the visible string exactly
   as it renders.
2. Read the accessible name the tree computes for the same control. `aria-label`
   and `aria-labelledby` override visible content entirely.
3. Ask whether the visible string appears inside the accessible name as a
   contiguous run in the same word order.
4. Ignore case and punctuation. Where the label is an icon plus text, only the
   text is compared.
5. A control with no visible text is out of scope - that is 1.1.1 and 4.1.2.

### Genuine failure

- A button reading "Send" with `aria-label="Submit application form"`. Saying
  "click Send" matches nothing.
- A link reading "Read more" with `aria-label="Learn about our accessibility
  commitments"`. The visible words are absent from the name entirely.
- A control reading "Search" with `aria-label="Site search"`. The extra word
  sits before the visible text, so the spoken command does not match from the
  start.
- A checkbox reading "I agree to the terms" whose `aria-labelledby` points at a
  hidden "Terms acceptance" string.
- An icon-plus-text button reading "Download" named "Export CSV".
- A tab reading "Payments" named "Billing" via `aria-labelledby`.

### False positive - do not report

- **Case differences.** "SEND" visible and "Send" in the name is a match.
- **Punctuation differences** - a trailing full stop, a colon, an ellipsis, a
  non-breaking space, a trailing arrow glyph.
- Extra words **after** the visible text. "Read more" visible with
  `aria-label="Read more about eligibility"` passes, and is often good practice.
- A label rendered in caps by `text-transform`. Compare the underlying text.
- An icon-only control with no visible text. See 1.1.1 and 4.1.2.
- Placeholder text, which is not a visible label here. If the placeholder is
  doing the labelling, that is 3.3.2 instead.

---

## 3.3.2 Labels or Instructions - Level A

### What the standard requires

Labels or instructions are provided when content requires user input. Every
control needs a **persistent** visible label, plus any instruction the user
needs **before** they commit: format requirements, required-ness, character or
file limits, anything the field will reject. Placeholder-as-label is the
canonical failure, because the text vanishes on the first keystroke and takes
the only description of the field with it.

### How to test it

1. For every input, `select`, `textarea`, combobox, file picker and editable
   cell, find the visible label in the screenshot. Is describing text visible
   while the field holds a value?
2. Check whether the field will reject input for a reason the user cannot see -
   date format, password rules, maximum length, permitted file types. Any such
   rule must be stated before submission, not only in the error afterwards.
3. Check that required fields are marked visibly and that the marker is
   explained.
4. Fill the field with sample text and look again. If the label vanished, it was
   a placeholder.
5. Confirm instructions sit beside the field, not in a collapsed panel or a
   tooltip that must be discovered.

### Genuine failure

- `input placeholder="Email address"` with no `label`, no visible caption and no
  `aria-label`.
- A date field requiring DD/MM/YYYY that says so only in the error message.
- A password field whose composition rules appear only after a rejected submit.
- A required field with no visible required marker anywhere on the form.
- A file upload stating neither accepted types nor maximum size.
- A four-box verification-code input with no collective label.
- A character-limited `textarea` with no stated limit, which silently truncates.

### False positive - do not report

- A placeholder used **in addition to** a visible persistent label. A hint inside
  the field is not a failure when a label exists.
- **An icon-only control with a tooltip.** There is no user input to label - it
  is a button, and its name is 1.1.1 and 4.1.2 territory, not 3.3.2.
- A visually hidden label exposed to the tree, where the purpose is clear from
  context, such as a search field beside a "Search" button.
- Instructions above the whole form rather than beside each field, where they
  clearly apply and are read first.
- A terse label. Short is not missing.
- An error arriving after submission where the requirement was also stated up
  front. Error quality is 3.3.1 and 3.3.3.

---

## Reporting rules for this group

- One finding per element per criterion. A field labelled only by a placeholder
  inside a group with no `fieldset` produces two findings, 3.3.2 and 1.3.1. A
  control both unlabelled in the tree and misnamed against its visible text
  produces separate 1.3.1 and 2.5.3 findings.
- Severity follows the user's task. A missing label or a broken label-in-name on
  a control in the primary flow is `critical`. A data table with no header
  semantics is `serious`. A cosmetic heading in a marketing section is
  `moderate`. A footer list built from `div` elements is `minor`.
- Report the structure you observed, not the structure you would have authored.
  "This should have been a `section`" is not a finding unless information is lost.
- Evidence discipline: quote the visible text and the computed accessible name
  side by side and name the attribute behind each - "the button at
  `#apply-submit` reads 'Send' and the tree computes 'Submit application form'
  from its `aria-label`". Never invent a selector, and never assert what the
  markup contains when you were given only a screenshot.
- Verdict: DECIDE when you hold both artefacts and they disagree. FLAG when you
  hold only one, or when the meaningfulness of a sequence is genuinely arguable.
  BLOCKED when the region was absent from both artefacts.
