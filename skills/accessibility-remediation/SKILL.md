---
name: accessibility-remediation
description: Recipes for turning DECIDE accessibility findings into minimal unified diffs, one patch per source file, each giving the wrong fix, the right fix and the framework notes for React, Next.js app router, Vue and plain HTML. Load when writing patches as the FIX agent.
---

# Writing the patch

You own no criteria. You take findings other lanes have already decided and
turn them into the smallest diff that removes the barrier. Everything below is
a recipe: the shape of the finding, the fix that looks right and is not, the
fix that is, and what changes per framework.

Lane: FIX. Input is DECIDE findings grouped by source file. Output is one
patch per file.

---

## 4.1.2 - a div that behaves like a button

**Finding.** A `div` or `span` carries an `onClick`, and the tree reports it as
generic text with no role and no name.

**Wrong.** Adding `role="button"` and stopping. The element is now announced as
a button and still cannot be reached or activated by keyboard, so you have made
the lie more convincing.

**Right.** Use the real element and get role, focusability, Enter, Space and the
disabled state for free.

```jsx
<button type="button" className="card-toggle" onClick={toggle}>Show details</button>
```

Only when the element genuinely cannot change - a table row, a grid cell, a
third-party wrapper that renders its own tag - do you add the ARIA form, and
then it is all three or none: role, `tabIndex`, and **both** key handlers.

```jsx
<div role="button" tabIndex={0} onClick={toggle}
  onKeyDown={(e) => {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
  }}>
```

**State.** Derive the state attribute from the same variable that drives the
visual state, so the two cannot diverge again.

```jsx
<button type="button" aria-expanded={isOpen} aria-controls="panel-1"
        onClick={() => setIsOpen(!isOpen)}>Filters</button>
<div id="panel-1" hidden={!isOpen}>{children}</div>
```

**Frameworks.** React: a real `button` needs no `onKeyDown`; adding one fires
twice on Space. Next.js app router: a server component cannot carry a handler,
so the finding is really in the client component underneath - patch that file,
and adding `"use client"` to a server component belongs in `skipped`. Vue:
`@click` on `button`, never `@keydown.enter` on a `div`. Plain HTML: always
`type="button"` inside a form, or it submits.

---

## 4.1.3 - announcing without moving focus

**Finding.** A result count, a save confirmation or a validation summary
appears silently.

**Wrong.** Mounting the live region and its text in the same render. A region
that appears already populated is often not announced at all, because there was
no change for the assistive technology to observe.

**Right.** Wrap an existing, already-mounted container, and change only its text
content later.

```jsx
<div role="status" aria-live="polite" className="visually-hidden">{statusMessage}</div>
```

`statusMessage` starts as an empty string and becomes "12 results" when the
search resolves. The container never unmounts.

**Frameworks.** React: never write `{done && <div role="status">Saved</div>}`.
Next.js app router: the region belongs in the client component that owns the
state, not in the server layout. Vue: keep it in the DOM with `v-show`, not
`v-if`. Use `role="alert"` only for errors - it is assertive and interrupts.

---

## 1.1.1 - alt text that carries the information

**Finding.** `alt="image"`, a filename, or an icon-only control with no name.

**Wrong.** `alt="icon"`, `alt="hero-banner-final-v2.png"`, or deleting the
attribute altogether.

**Right.** Say what the image tells a sighted user. Name the action for a
functional image; remove decoration from the tree entirely.

```jsx
<img src={chart} alt="Revenue by quarter. Q1 1.2M, Q2 1.4M, Q3 1.1M, Q4 1.9M" />
<img src={divider} alt="" />
<button type="button" aria-label="Search"><SearchIcon aria-hidden="true" /></button>
```

**Frameworks.** Next.js `next/image` takes the same `alt` and requires it.
Inline SVG as a control's only content gets `aria-hidden="true"`, with the name
on the control. Vue: a bound `:alt` that can be `undefined` is not a fix.

---

## 3.3.2 - a real label

**Finding.** An input identified only by a placeholder, or by a `div` above it.

**Wrong.** Adding `aria-label` on top of visible text. The visible text is then
unassociated and the two drift apart.

**Right.** Associate the text that is already on screen.

```jsx
<label htmlFor="email">Email address</label>
<input id="email" type="email" name="email" autoComplete="email" />
```

`aria-label` is only for a control with no visible label and nowhere to put one.

**Frameworks.** React: `htmlFor`, and `useId()` when the component renders more
than once per page. Vue and plain HTML: `for`. Wrapping the input inside the
`label` also associates it, and is the right fix when no stable id exists.

---

## 3.3.1 and 3.3.3 - errors identified, described and announced

**Finding.** Submitting empty turns the border red and nothing else, or the
message says "Invalid" without saying what would be valid.

**Wrong.** Colour only. A `title` attribute. A toast that vanishes in three
seconds. Wording that names the failure but not the remedy.

**Right.** Text beside the field, wired to it, plus a container that announces.

```jsx
<input id="dob" aria-invalid={!!error}
       aria-describedby={error ? "dob-error" : undefined} />
{error && <p id="dob-error" className="field-error">{error}</p>}
<div role="alert">{summary}</div>
```

Wording carries the remedy: "Enter your date of birth as DD/MM/YYYY, for
example 21/03/1990", not "Invalid date".

**Frameworks.** The `role="alert"` summary is mounted once and filled later, per
the 4.1.3 recipe. Next.js app router with a server action: the error arrives
through form state, so the wiring lives in the client component. Vue:
`:aria-describedby` must be `undefined`, not `null` or `false`, when clean.

---

## 2.4.7 - put the focus indicator back

**Finding.** `outline: none` in a stylesheet, or a reset stripping focus rings
from every control.

**Wrong.** Removing an outline and replacing it with nothing, or with a colour
change measuring under 3:1.

**Right.** Replace the indicator, scoped so pointer users do not see it.

```css
.button:focus-visible {
  outline: 2px solid #1a5fb4;
  outline-offset: 2px;
}
```

Where a reset is the culprit, patch the reset, not each component.

**Frameworks.** Tailwind: `focus-visible:outline-2 focus-visible:outline-offset-2`.
Do not reach for `focus:` in a project that already uses `focus-visible:`.

---

## 1.4.3 - move the token, not the component

**Finding.** Text measured below 4.5:1, or below 3:1 for large text.

**Wrong.** Overriding the colour inline on one component. The next component
using that token still fails and the design system now has two truths.

**Right.** Where the project has design tokens, change the token.

```diff
-  --color-text-muted: #9e9e9e;   /* 2.85:1 on white */
+  --color-text-muted: #6b6b6b;   /* 5.13:1 on white */
```

State the new ratio in `rationale`, with both colours and the threshold that
applied. Darken or lighten within the same hue family so the design still reads
as itself.

**Frameworks.** Tailwind: change the palette entry in the config, not the
utility class. No token system: patch the one rule that sets the failing colour.

---

## 2.5.8 - grow the hit area, not the glyph

**Finding.** A control under 24 by 24 CSS pixels, with neighbours too close for
the spacing exception.

**Wrong.** Scaling the icon up. That is a visual redesign and will be rejected.

**Right.** Pad the control, leaving the glyph exactly as it is.

```css
.icon-button {
  min-width: 24px; min-height: 24px; padding: 6px;
  display: inline-flex; align-items: center; justify-content: center;
}
```

Where layout will not allow a bigger box, add spacing until the 24px circles
stop overlapping, and say in `rationale` which exception now applies.

---

## 1.3.1 - real semantics instead of styled divs

**Finding.** Styled `div` elements standing in for headings, lists, tables or
grouped fields.

**Wrong.** Adding `role="heading"` to the `div`. ARIA is a last resort, and that
role still needs `aria-level`.

**Right.** Replace the element and keep the class so the styling is unchanged.

```diff
-<div className="section-title">Eligibility</div>
+<h2 className="section-title">Eligibility</h2>
```

Same move for the rest: `ul` or `ol` with `li` for lists, `table` with `th
scope="col"` or `scope="row"` for tabular data, `fieldset` with `legend` for a
radio or checkbox group.

**Frameworks.** Where flex or grid styling would break under a `ul`, add
`list-style: none` and `margin: 0` rather than abandoning the list, and note it
in `risk`. Next.js app router: heading structure often lives in a layout - fix
it where it renders.

---

## 2.5.3 - the name must contain the visible text

**Finding.** A control whose visible text is "Send" and whose `aria-label` is
"Submit form". Voice control users say what they see and nothing happens.

**Wrong.** Changing the visible text to match the label.

**Right.** Drop the overriding label, or make the name start with the visible
string, in the same order.

```diff
-<button aria-label="Submit form">Send</button>
+<button>Send</button>
```

`aria-label="Send message to support"` is also valid, because it contains
"Send" at the start.

---

## 3.1.1 - lang on the root

**Finding.** No `lang` on the `html` element.

**Right.** Patch the root layout, once.

```diff
-  <html>
+  <html lang="en-GB">
```

**Frameworks.** Next.js app router: `app/layout.tsx`. Pages router:
`pages/_document.tsx`. Vite, CRA and Vue: `index.html` or the SSR template.
Match the site's actual language; do not default to `en`.

---

## Hard rules

- Act only on findings with verdict DECIDE. Leave every FLAG finding completely
  alone, including ones you are confident about. They belong to a human.
- One patch per source **file**, covering every finding in that file. Never one
  patch per finding, and every file appears in `patches` exactly once.
- Every patch names the criterion numbers it addresses in `criteria`. A patch
  that cannot name a criterion should not exist.
- Change the minimum. No reformatting, no renaming, no restructuring, no
  dependency upgrades, no improving adjacent code. Every unrelated line is a
  reason for a reviewer to reject the whole patch.
- Do not change visual design. Names, roles, state attributes, label
  associations and focus styles are in scope. Redesigning a component is not.
- Preserve the framework's idioms. A file using a UI library's `Button` keeps
  using it. A server component stays a server component.
- Diffs must apply cleanly against the file exactly as you were given it, using
  exact surrounding context and the file's own indentation and quote style.
- When a fix is not safe, put the finding in `skipped` with a real reason - "the
  handler is in a compiled vendor bundle", not "needs review". Skipping honestly
  beats a patch that breaks the build.

---

## Patch hygiene checklist

Run this before emitting. Every answer is yes, or the patch does not go out.

1. Does every hunk carry correct context lines copied from the file as given,
   with accurate line counts in the `@@` header?
2. Does the file still parse - balanced JSX tags, closed braces, no duplicated
   attribute on one element?
3. Did I touch only lines a finding pointed at, plus what those changes strictly
   require?
4. Does every changed file appear exactly once in `patches`?
5. Does every entry name its criteria, and are they the criteria the findings
   actually carried?
6. Does `rationale` say something a reviewer can check - the new ratio, the new
   accessible name, the element that replaced the `div`?
7. Is anything a reviewer should watch recorded in `risk`, and is every finding
   I did not patch in `skipped` with its reason?

Output the JSON object and nothing else. No prose before it, none after it.
