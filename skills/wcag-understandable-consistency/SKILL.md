---
name: wcag-understandable-consistency
description: Comparing a crawled set of pages against each other for WCAG 2.4.5 Multiple Ways, 3.2.3 Consistent Navigation, 3.2.4 Consistent Identification, 3.2.6 Consistent Help and 3.3.7 Redundant Entry, to load in the PAGES lane once a crawl has produced two or more pages from one site.
---

# Comparative criteria across a set of pages

None of these five criteria can be judged from a single page. The unit of evidence
is a comparison, never an observation. If fewer than two pages were supplied,
return an empty findings array and say nothing else - that is the correct answer
here, not a failure to do the work.

Every finding names both pages by URL and quotes both sides: both orders, both
labels, both positions. A finding with one page in it proves nothing.

Lane: PAGES. All DECIDE except 3.3.7, which is FLAG.

---

## Build the comparison table first

Do this once, before ruling on anything. One row per page.

| Column | What goes in it |
|---|---|
| `url` | The page URL as crawled |
| `navOrder` | Accessible names of each repeated navigation, in DOM order, per mechanism |
| `functions` | A map of function to accessible name plus icon - search, submit, cancel, print, next, close, help |
| `helpPos` | The help affordance, its type, and its position relative to the page landmarks |
| `inbound` | Every route that reaches this page - from which page, by which mechanism |

Then diff the rows. 3.2.3 comes out of `navOrder`, 3.2.4 out of `functions`, 3.2.6
out of `helpPos`, 2.4.5 out of `inbound`. Do not rule on a criterion until its
column is filled for every page you were given.

---

## 2.4.5 Multiple Ways - Level AA

### What the standard requires

More than one way must be available to locate a page within a set of pages, except
where the page is the result of, or a step in, a process. Two routes, and they
must be independent mechanisms: site navigation that covers the page, a search
facility, a sitemap, a table of contents, a list of related links, or a breadcrumb
trail that is genuinely navigable - links, not plain text.

### How to test it

1. Fill `inbound` for every page from the whole crawl, not from the page itself.
2. Classify each route by mechanism. Two links inside the same navigation menu are
   one route, not two.
3. If you counted a search facility, confirm it returns the page. A search box
   scoped to a blog does not make a product page reachable.
4. If you counted a sitemap, confirm it is an HTML page a user can reach, not an
   XML file written for crawlers.
5. Before ruling a failure, ask whether the page is a step in a process.

### Genuine failure

- A page reachable only from one link in one drop-down menu, on a site with no
  search facility and no sitemap.
- A site whose only claimed second route is `/sitemap.xml`.
- A breadcrumb rendered as plain text with no links, counted as a route.
- A search box posting to a third-party engine that does not index the page.
- Content reachable only from a carousel slide found on one page.

### False positive - do not report

- A checkout step, a payment confirmation, a "thank you" page, or any step inside
  a linear funnel. Explicitly exempt.
- A page reachable from the navigation and from an in-content link on a related
  page. Related links are a listed mechanism; do not demand a search box as well.
- A login page, legal notice or contact page linked from the footer navigation of
  every page. The footer navigation is a route.
- Fewer than two pages supplied. You cannot build `inbound` from one page.

---

## 3.2.3 Consistent Navigation - Level AA

### What the standard requires

Navigational mechanisms repeated on multiple pages within a set occur in the same
relative order each time, unless the user initiated the change. Relative order,
not absolute position. Items may be added and items may be removed; the items
present on both pages must not be transposed.

### How to test it

1. Take `navOrder` for two pages. Remove from each list any name absent from the
   other. What remains is the comparable sequence.
2. Compare the two comparable sequences element by element. Any difference in
   order is a failure.
3. Do this per mechanism, separately: header navigation, footer navigation,
   sidebar, breadcrumb, skip-link block.
4. Compare like viewports. Take every snapshot at the same viewport width.
5. Quote both sequences in `detail`, comma-separated, with the page each came from.

### Genuine failure

- `/apply` lists Home, Apply, Status, Help; `/status` lists Home, Status, Apply,
  Help. Apply and Status are transposed.
- A footer alphabetised on one template and hand-ordered on another.
- A sidebar that promotes the current section to the top of the list on the page
  you happen to be on.
- A breadcrumb that reverses direction between two templates.
- A language switcher first in the header on the home page and last in the header
  on every interior page.

### False positive - do not report

- A page that legitimately drops a navigation item because it is not applicable
  there. Removal is allowed; only transposition of the survivors fails.
- A responsive layout that collapses the navigation into a menu button at a narrow
  viewport. That is a different presentation, not a reordering.
- The current item marked with `aria-current="page"` while staying in place.
- An added item, such as a "Basket (2)" that appears once the basket fills.
- A user-initiated change - a personalised or reorderable menu the user set up.

---

## 3.2.4 Consistent Identification - Level AA

### What the standard requires

Components with the same functionality within a set of pages are identified
consistently: the same accessible name and the same icon. The criterion is about
the label, not the position.

### How to test it

1. Fill `functions` per page. For each repeated function record the accessible
   name, the visible text, and the icon - its file, sprite id or glyph.
2. Group by function across pages: search, submit, cancel, print, download, next,
   previous, close, help, log out.
3. Any function whose name differs between pages is a candidate. So is any whose
   icon differs while the name stays the same.
4. Confirm the two really are one function before ruling. A search scoped to the
   site and a search scoped to a document library are different functions.
5. Cite both pages and quote both names.

### Genuine failure

- The site search box labelled "Search" on `/` and "Find" on `/products`.
- A submit labelled "Submit" on one step and "Send" on the next, where both submit
  the same application.
- A print action shown as a printer glyph on one page and a document glyph on
  another.
- A modal close named "Close" on one dialog and "Dismiss" on another doing the
  same thing.
- The same file offered as "PDF" on one page and "Download the report" on another.

### False positive - do not report

- A "Home" link on the logo plus a "Home" item in the navigation on the same page.
  Two components, one function, one name - that is consistency, not a failure.
- Different wording for genuinely different functions. "Save" and "Save and
  continue" are not the same function.
- One word used for two different functions. 3.2.4 is one function with two names,
  not the reverse.
- An icon that changes to show state - a bookmark that fills once set - where the
  accessible name changes with it.
- Names differing only by whitespace, case or a trailing full stop. Normalise
  before comparing.

---

## 3.2.6 Consistent Help - Level A

### What the standard requires

New in WCAG 2.2. If any of four help mechanisms is available on multiple pages in
a set, it occurs in the same relative order relative to other page content on each
of those pages. The four: human contact details, a human contact mechanism, a
self-help option, and a fully automated contact mechanism such as a chat bot. It
need not appear on every page. It must not move.

### How to test it

1. Identify the help affordance on every page that has one and classify it. A
   telephone number is human contact details, a "Contact us" link is a human
   contact mechanism, an FAQ link is a self-help option, a chat widget is an
   automated contact mechanism.
2. Record its position relative to other content - which landmark, where within
   it, and what comes immediately before and after. Relative order, not pixels.
3. Compare only the pages that have it.
4. Where a page carries two help mechanisms, compare each type separately.

### Genuine failure

- A help telephone number in the header on `/` and in the footer on `/apply`.
- A chat launcher that is the last element of the footer on most pages and
  injected above `main` on the checkout page.
- A "Contact us" link first in the footer list on one template and fourth on
  another.
- A help link inside the header navigation on one page and inside the page body
  on another.

### False positive - do not report

- A page with no help mechanism at all. The criterion applies only to the pages
  that offer one.
- A help mechanism that sits elsewhere because the viewport changed. Compare like
  viewports.
- A pixel-position difference caused by the content above it being longer or
  shorter. Relative order is what matters.
- A contextual help link inside one form field's instructions. Page content, not a
  repeated help mechanism.
- A chat widget collapsed on some pages and expanded on others, in the same place.

---

## 3.3.7 Redundant Entry - Level A

### What the standard requires

Information the user already entered in the same process must be auto-populated or
available to select. From this lane you see it across pages: a later page in a
multi-step process re-asking for what an earlier page collected. Exceptions:
re-entry is essential, it is required for security, or the earlier information is
no longer valid.

### How to test it

1. Identify processes in the crawl - sequences of pages sharing a step indicator,
   a common URL prefix, or a "Continue" chain.
2. For each process, list the field names and labels each page collects.
3. Look for a label collected on page N that reappears on a later page with no
   pre-filled value and no control offering the earlier answer.
4. You are comparing structure, not a live session, so you will rarely see the
   pre-fill itself. Form an opinion and flag it. ACT owns the live check.
5. Name both pages and both field labels.

### Genuine failure

- `/checkout/delivery` collects address line 1, town and postcode;
  `/checkout/billing` collects the same three, with no "same as delivery" control
  anywhere in the markup.
- A three-page application asking for the date of birth on pages 1 and 3.
- A booking flow collecting the email on the details page and again on the
  confirmation page.

### False positive - do not report

- A password and its confirmation field. Explicit exception.
- A security re-check: a card CVV, a password confirmed before a sensitive change.
- Two pages that are not one process. A footer newsletter sign-up is not part of
  the checkout.
- A later page offering the earlier value for selection rather than pre-filling
  it. Selection satisfies the criterion.
- Same-labelled fields collecting genuinely different things - a delivery address
  and a separate cardholder address the user may want to differ.

---

## Reporting rules for this group

- If fewer than two pages were supplied, return an empty findings array. Do not
  narrate the limitation as a finding and do not emit BLOCKED for it.
- One finding per comparison per criterion, not one per page. A navigation
  reordered across four pages is one 3.2.3 finding quoting the two orders you
  compared, not four findings.
- Every finding names both pages by URL and quotes both sides. "The nav on /apply
  lists Home, Apply, Help; on /status it lists Apply, Home, Help - the first two
  are transposed" is a finding. "Navigation is inconsistent" is not.
- Severity is about the user's task. A navigation transposition inside a checkout
  funnel is `serious`; a footer link reordered between two marketing pages is
  `minor`. Two names for the submit control of one application is `serious`. A
  page with only one route, on a site with no search, is `serious`; the same on a
  page nobody needs to find directly is `minor`.
- Evidence discipline. Quote only from the material you were given. Never invent a
  selector, a URL, or a navigation item you did not see in the crawl output. If a
  page's navigation or help region was missing from your input you cannot compare
  it - omit the comparison and say so rather than guessing.
- Verdict policy. 2.4.5, 3.2.3, 3.2.4 and 3.2.6 are DECIDE: a comparison across
  pages settles them. 3.3.7 is FLAG on every finding, because from page structure
  alone you cannot see whether a value would have been pre-filled at runtime. Use
  BLOCKED only when a page you were told to compare arrived with the region you
  needed unreadable.
