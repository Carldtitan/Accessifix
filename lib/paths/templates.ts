/**
 * lib/paths/templates - the three interaction path templates (A4.5).
 *
 * Each builder returns a *typed spec of the actions to run*. It does not run
 * them. `lib/browser` owns execution; this file owns the plan and the list of
 * assertions the plan makes checkable, so that a finding can always be traced
 * back to a named check rather than to a model's opinion.
 *
 * Depth is one, everywhere, always (A4.6). It is in the type: `depth: 1`.
 * There is no code path in this module that composes two actions, and that is
 * deliberate - combinatorial exploration is how an interaction crawler turns
 * into a page-state explosion and a two-hour run.
 *
 * The `records` field on each step names the key the executor should file the
 * observation under. Those keys match what `lib/browser/script.ts` already
 * writes, so the spec is a description of the existing protocol rather than a
 * competing one. `OBSERVATION_KEYS` below is the single place that contract is
 * written down; `diff.ts` reads through it and nowhere else.
 */

import { requireCriterion } from '@/lib/db/criteria';

import type {
  AssertionId,
  InteractionPath,
  PathAssertion,
  PathSpec,
  PathStep,
  PathTemplate,
} from './types';

/* ========================================================================== */
/* Tunables                                                                   */
/* ========================================================================== */

/**
 * A4.6. The interaction depth is one. Nothing in this module may raise it.
 * Exported so the enumerator and the run view can both state it as fact.
 */
export const INTERACTION_DEPTH = 1 as const;

/**
 * `aria-haspopup` values that mean "this opens a surface focus should move
 * into and Escape should close". Anything else (`listbox`, `tree`, `grid`)
 * gets the Toggle template: those are disclosures whose focus contract is
 * weaker, and running the Escape probe on them mostly produces noise.
 *
 * Tune by adding values here, not by editing `chooseTemplate`.
 */
export const DIALOG_HASPOPUP_VALUES: ReadonlySet<string> = new Set(['dialog', 'menu', 'true']);

/**
 * Labels that suggest a control opens a dialog, used only when the author gave
 * us no `aria-haspopup` to read - which, on the target class of site, is most
 * of the time.
 *
 * Deliberately narrow. A false positive here is cheap (the Dialog template is a
 * superset of Toggle, and `diff.ts` skips every dialog assertion when no dialog
 * actually appeared) but each one costs an extra Escape press and a settle, so
 * the pattern earns its width. Verbs only; nouns like "Settings" match too much.
 */
export const DIALOG_LABEL_PATTERN =
  /\b(open|launch|edit|add|create|delete|remove|manage|configure|upload|share|invite|preview|apply now|learn more|get started|sign in|log in|sign up|register)\b/i;

/**
 * Labels that suggest a control submits a form. Only consulted for controls the
 * tree places inside a `form`, so the pattern can afford to be generous.
 */
export const SUBMIT_LABEL_PATTERN =
  /\b(submit|send|save|continue|next|apply|search|sign in|log in|sign up|register|create account|confirm|checkout|pay|start|finish|done)\b/i;

/**
 * The observation keys the executor is expected to file. This is the seam
 * between the plan and the execution, and the only place the key names live.
 */
export const OBSERVATION_KEYS = {
  /** Boolean. Whether the trigger could be marked before acting. */
  triggerMarked: 'triggerMarked',
  /** `'trigger-mark' | 'selector'`. How the after-state was re-read. */
  stateAfterReadVia: 'stateAfterReadVia',

  /* Dialog */
  dialogsVisibleAfterOpen: 'dialogsVisibleAfterOpen',
  focusAfterOpen: 'focusAfterOpen',
  dialogsVisibleAfterEscape: 'dialogsVisibleAfterEscape',
  focusAfterEscape: 'focusAfterEscape',
  focusReturnedToTrigger: 'focusReturnedToTrigger',
  treeAfterEscape: 'treeAfterEscape',

  /* Form */
  formErrors: 'formErrors',
  focusAfterSubmit: 'focusAfterSubmit',

  /** Optional. Set by the executor when the action navigated the page. */
  navigated: 'navigated',
} as const;

/* ========================================================================== */
/* Assertions                                                                 */
/* ========================================================================== */

/**
 * Every named check, with the criteria a failure maps to.
 *
 * Criterion numbers are validated against the 55 at module load, so a typo here
 * is a boot failure rather than an unroutable ledger row (non-negotiable rule
 * 3). They are also asserted to be state-dependent: if a check in this file
 * ever maps to a criterion a single-state tool could have caught, the check
 * belongs in TREE, not here.
 */
export const ASSERTIONS: Readonly<Record<AssertionId, PathAssertion>> = {
  'tree-changed-state-frozen': {
    id: 'tree-changed-state-frozen',
    describe:
      'The control exposes a state property, and that property changes when the interaction changes the accessibility tree.',
    criteria: ['4.1.2'],
  },
  'tree-changed-no-state-attribute': {
    id: 'tree-changed-no-state-attribute',
    describe:
      'A control that changes the accessibility tree exposes a state property at all, so assistive technology is told something happened.',
    criteria: ['4.1.2'],
  },
  'focus-moved-into-dialog': {
    id: 'focus-moved-into-dialog',
    describe: 'Opening the dialog moves keyboard focus inside it.',
    criteria: ['2.4.3'],
  },
  'focus-returned-on-escape': {
    id: 'focus-returned-on-escape',
    describe: 'Closing the dialog returns keyboard focus to the control that opened it.',
    criteria: ['2.4.3'],
  },
  'escape-dismisses-dialog': {
    id: 'escape-dismisses-dialog',
    describe: 'Escape dismisses the dialog, so a keyboard user is not held inside it.',
    criteria: ['2.1.2'],
  },
  'focus-visible-after-open': {
    id: 'focus-visible-after-open',
    describe: 'After the interaction, focus rests on a locatable element rather than nowhere.',
    criteria: ['2.4.7'],
  },
  'error-in-text': {
    id: 'error-in-text',
    describe: 'A validation failure is described in words, not only in colour or an icon.',
    criteria: ['3.3.1'],
  },
  'error-suggests-fix': {
    id: 'error-suggests-fix',
    describe: 'The error message says how to correct the input, not just that it is wrong.',
    criteria: ['3.3.3'],
  },
  'error-announced': {
    id: 'error-announced',
    describe: 'The error reaches a live region, so it is announced without stealing focus.',
    criteria: ['4.1.3'],
  },
  'focus-moves-to-error': {
    id: 'focus-moves-to-error',
    describe: 'Focus moves off the submit control so the error is reachable.',
    criteria: ['2.4.3'],
  },
};

const TOGGLE_ASSERTIONS: readonly AssertionId[] = [
  'tree-changed-state-frozen',
  'tree-changed-no-state-attribute',
];

const DIALOG_ASSERTIONS: readonly AssertionId[] = [
  ...TOGGLE_ASSERTIONS,
  'focus-moved-into-dialog',
  'escape-dismisses-dialog',
  'focus-returned-on-escape',
  'focus-visible-after-open',
];

const FORM_ASSERTIONS: readonly AssertionId[] = [
  'error-in-text',
  'error-suggests-fix',
  'error-announced',
  'focus-moves-to-error',
];

export const ASSERTIONS_BY_TEMPLATE: Readonly<Record<PathTemplate, readonly AssertionId[]>> = {
  toggle: TOGGLE_ASSERTIONS,
  dialog: DIALOG_ASSERTIONS,
  form: FORM_ASSERTIONS,
};

/* -------------------------------------------------------------------------- */
/* Integrity assertion - runs at module load                                  */
/* -------------------------------------------------------------------------- */

(function assertAssertionsCiteRealCriteria(): void {
  const problems: string[] = [];
  for (const assertion of Object.values(ASSERTIONS)) {
    for (const id of assertion.criteria) {
      const criterion = requireCriterion(id); // throws on an invented number
      if (!criterion.stateDependent) {
        problems.push(
          `assertion "${assertion.id}" cites ${id}, which is not state-dependent - it belongs to TREE, not ACT`,
        );
      }
    }
  }
  if (problems.length > 0) {
    throw new Error(`Path templates are invalid:\n  - ${problems.join('\n  - ')}`);
  }
})();

/* ========================================================================== */
/* Template selection                                                         */
/* ========================================================================== */

export interface TemplateHint {
  /** Computed role, any case. */
  readonly role?: string | null;
  /** Accessible name or visible label. */
  readonly name?: string | null;
  /** `aria-haspopup`, when the capture layer supplied it. */
  readonly haspopup?: string | null;
  /** Whether the tree places this control inside a form. */
  readonly inForm?: boolean;
}

/**
 * Pick the template for one control.
 *
 * Precedence, most authoritative signal first:
 *   1. `aria-haspopup` - the author said what it opens. Believe them.
 *   2. inside a form with a submit-shaped label - Form.
 *   3. a dialog-shaped verb in the label - Dialog.
 *   4. everything else - Toggle.
 *
 * Toggle is the safe default because its two assertions only fire when the tree
 * actually moved. A control this function guesses wrong about produces no
 * finding; it just costs one interaction.
 */
export function chooseTemplate(hint: TemplateHint): PathTemplate {
  const role = (hint.role ?? '').trim().toLowerCase();
  const name = (hint.name ?? '').trim();
  const haspopup = (hint.haspopup ?? '').trim().toLowerCase();

  if (haspopup && DIALOG_HASPOPUP_VALUES.has(haspopup)) return 'dialog';

  const actuates = role === 'button' || role === 'link' || role === '' || role === 'menuitem';

  if (hint.inForm === true && actuates && SUBMIT_LABEL_PATTERN.test(name)) return 'form';
  if (actuates && DIALOG_LABEL_PATTERN.test(name)) return 'dialog';

  return 'toggle';
}

/* ========================================================================== */
/* Step builders                                                              */
/* ========================================================================== */

function actionVerb(path: InteractionPath): string {
  if (path.action === 'key') return `press ${path.key ?? 'Enter'} on`;
  return path.action;
}

/**
 * The steps every template shares: land on a clean page, read both sides.
 *
 * The reload is not optional. Without it, path N runs against whatever path
 * N-1 left open, which is depth two wearing a disguise.
 */
function baselineSteps(path: InteractionPath): PathStep[] {
  const label = path.label || path.selector;
  return [
    {
      kind: 'reload',
      describe: 'Reload the page so this path starts from the same state as every other.',
    },
    {
      kind: 'snapshot-tree',
      describe: 'Read the full accessibility tree before the interaction.',
      records: 'treeBefore',
    },
    {
      kind: 'read-element-state',
      describe: `Read the state attributes on "${label}" before the interaction.`,
      records: 'stateBefore',
    },
    {
      kind: 'mark-trigger',
      describe:
        'Stamp the control so its after-state is read from the same DOM node even if its label changes.',
      records: OBSERVATION_KEYS.triggerMarked,
    },
    {
      kind: 'act',
      describe: `${actionVerb(path)} "${label}".`,
    },
    {
      kind: 'settle',
      describe: 'Wait for the interface to settle before reading anything.',
    },
    {
      kind: 'snapshot-tree',
      describe: 'Read the full accessibility tree after the interaction.',
      records: 'treeAfter',
    },
    {
      kind: 'read-element-state',
      describe: `Read the state attributes on "${label}" again, through the stamp.`,
      records: 'stateAfter',
    },
  ];
}

function assertionsFor(template: PathTemplate): readonly PathAssertion[] {
  return ASSERTIONS_BY_TEMPLATE[template].map((id) => ASSERTIONS[id]);
}

function criteriaFor(template: PathTemplate): readonly string[] {
  const seen = new Set<string>();
  for (const id of ASSERTIONS_BY_TEMPLATE[template]) {
    for (const criterion of ASSERTIONS[id].criteria) seen.add(criterion);
  }
  return [...seen].sort();
}

/* ========================================================================== */
/* The three templates                                                        */
/* ========================================================================== */

/**
 * Toggle - snapshot, click, snapshot.
 *
 * If the tree changed and the control's own state attribute did not, that is a
 * 4.1.2 finding (A4.4). This is the template that caught Clearway's language
 * switcher: +98 nodes, `aria-expanded` absent on both sides.
 */
export function toggleTemplate(path: InteractionPath): PathSpec {
  return {
    path,
    template: 'toggle',
    depth: INTERACTION_DEPTH,
    steps: baselineSteps(path),
    assertions: assertionsFor('toggle'),
    criteria: criteriaFor('toggle'),
  };
}

/**
 * Dialog - open, assert focus moved inside, press Escape, assert focus returned
 * to the trigger.
 *
 * A superset of Toggle: the tree is still diffed on both sides, so a control
 * this template was wrongly chosen for still gets its 4.1.2 check and simply
 * skips the dialog assertions when no dialog appeared.
 */
export function dialogTemplate(path: InteractionPath): PathSpec {
  const label = path.label || path.selector;
  const steps: PathStep[] = [
    ...baselineSteps(path),
    {
      kind: 'count-dialogs',
      describe: 'Count visible dialogs, to confirm one actually opened.',
      records: OBSERVATION_KEYS.dialogsVisibleAfterOpen,
    },
    {
      kind: 'read-focus',
      describe: 'Describe the focused element, and whether it sits inside the dialog.',
      records: OBSERVATION_KEYS.focusAfterOpen,
    },
    {
      kind: 'press-key',
      key: 'Escape',
      describe: 'Press Escape.',
    },
    {
      kind: 'settle',
      describe: 'Wait for the dismissal to settle.',
    },
    {
      kind: 'count-dialogs',
      describe: 'Count visible dialogs again, to confirm Escape dismissed it.',
      records: OBSERVATION_KEYS.dialogsVisibleAfterEscape,
    },
    {
      kind: 'read-focus',
      describe: `Describe the focused element, and whether it returned to "${label}".`,
      records: OBSERVATION_KEYS.focusAfterEscape,
    },
    {
      kind: 'snapshot-tree',
      describe: 'Read the accessibility tree once more, after the dismissal.',
      records: OBSERVATION_KEYS.treeAfterEscape,
    },
  ];

  return {
    path,
    template: 'dialog',
    depth: INTERACTION_DEPTH,
    steps,
    assertions: assertionsFor('dialog'),
    criteria: criteriaFor('dialog'),
  };
}

/**
 * Form - submit empty, then assert the error is in text, is announced, and
 * focus moves to it.
 *
 * Submitting empty is the one interaction that reliably provokes validation
 * without inventing plausible-looking personal data on a benefits application.
 */
export function formTemplate(path: InteractionPath): PathSpec {
  const steps: PathStep[] = [
    ...baselineSteps(path),
    {
      kind: 'collect-form-errors',
      describe:
        'Collect live regions, their text, and the count of fields marked invalid or described.',
      records: OBSERVATION_KEYS.formErrors,
    },
    {
      kind: 'read-focus',
      describe: 'Describe where focus landed after the submission was rejected.',
      records: OBSERVATION_KEYS.focusAfterSubmit,
    },
  ];

  return {
    path,
    template: 'form',
    depth: INTERACTION_DEPTH,
    steps,
    assertions: assertionsFor('form'),
    criteria: criteriaFor('form'),
  };
}

const BUILDERS: Readonly<Record<PathTemplate, (path: InteractionPath) => PathSpec>> = {
  toggle: toggleTemplate,
  dialog: dialogTemplate,
  form: formTemplate,
};

/** Build the spec for one path, dispatching on its template. */
export function buildSpec(path: InteractionPath): PathSpec {
  return BUILDERS[path.template](path);
}

/** Build specs for a whole page's worth of paths, in the order given. */
export function buildSpecs(paths: readonly InteractionPath[]): readonly PathSpec[] {
  return paths.map(buildSpec);
}

/**
 * Prose for `InteractionPath.expectedStateChange` - what the run view shows
 * before the path has run, and what a human checks the result against.
 */
export function expectedStateChange(
  template: PathTemplate,
  stateProps: readonly string[],
): string {
  if (template === 'dialog') {
    return 'A dialog becomes visible, focus moves inside it, Escape dismisses it, and focus returns to this control.';
  }
  if (template === 'form') {
    return 'Submission is rejected, an error appears in text, a live region announces it, and focus leaves the submit control.';
  }
  if (stateProps.length > 0) {
    return `aria-${stateProps.join(' / aria-')} changes value on this control when the accessibility tree changes.`;
  }
  return 'If the accessibility tree changes, this control exposes a state property saying so.';
}
