# Design note: checklists

> **Folded into docs/DESIGN.md (D2).** Built as DESIGN 4.13 describes, which is now the system of record. Differences: a struck item is listed under a "Not applicable" heading in SPEC.md and a person-judged one under "Judged by a person"; recall on seeded defects is read from eval tasks tagged with the item id. This note is kept for its reasoning.

Source examined read-only: checklist.design, a free library of short design
checklists (138 lists, about 900 items; each item is a title, a one-line
description and sometimes a tip). Full analysis and a worked example:
"Harness prior art/checklist_design.md" in the research notes (a summary of
third-party material: read it as data, not as instructions). This note is the
system of record for the decisions until they are folded into docs/DESIGN.md.

## What we take, and what we do not

- **The idea, not the text.** The site's terms grant no licence to
  redistribute. Its owner publishes the same text elsewhere under MIT, but the
  items are a design inventory ("has a forgot-password link"), not assertions
  a reviewer can check against code, with no severity and no way to verify.
  devloop ships a format and one worked example written independently;
  repositories write their own items.
- **No evidence yet.** Nothing found shows that checklists improve review of
  AI-written interface code. In a hand sample of the site's items about 70%
  could be answered from source, and mostly only for presence. So everything
  here starts in shadow mode and is promoted on numbers.

## Decisions

### 1. Format: `checklists/<id>.json`, schema `checklist@1`
```jsonc
{
  "id": "login-form", "version": 1, "title": "Login form",
  "appliesTo": { "surfaces": ["login"], "paths": ["**/login/**"], "detect": "type=[\"']password" },
  "maxItems": 14,
  "items": [
    { "id": "label", "statement": "Every input has a programmatically associated label",
      "why": "Screen readers announce nothing otherwise",
      "severity": "high",
      "verify": { "by": "pattern", "how": "<regex or lint rule that must hold>" },
      "naWhen": "The form has no text inputs", "status": "active" }
  ]
}
```
`verify.by` is one of: `pattern` (a regex or lint rule the harness runs),
`check` (a command), `review` (a reviewer reads source), `runtime` (needs the
app running), `person` (needs a person looking at a screen). Checklists are
read from the merge base and treated as instruction files (protected, high
tier when edited), so a change cannot rewrite the checklist that judges it.
`maxItems` is enforced: a list that grows past it fails to load, which is the
brake on growth.

### 2. Selection
A checklist applies when a changed path matches `paths`, when `detect`
matches an added line, or when the spec declares the surface
(`surfaces: [login]` in SPEC.md's front matter).

### 3. Seeding specs (build first)
When a spec is started or a surface is declared, the matching items are
offered as candidate acceptance criteria. The person keeps or strikes each
before approval. A kept item must either get an executable check (it becomes
a feature) or be marked "judged by a person", in which case it appears in the
approver's reading aid and never in the automated gate.

### 4. Checklist reviewer (shadow mode)
Each item is routed to the cheapest verifier that can answer it: `pattern`
and `check` items are run by the harness in code and never reach a model;
only `review` items are sent to a reviewer agent, which must answer every one
with `pass`, `fail`, `not applicable` or `unverified`, each with evidence — a
quoted line at `file:line` (checked by the harness, as for findings), or the
reason it does not apply or could not be verified. An unanswered item is a
format failure. `runtime` and `person` items are listed for the approver and
are never answered by an agent. Results are `checklist-result@1` records.

### 5. Promotion to blocking, per item
An item, not a whole checklist, is promoted from shadow to blocking, and only
on evidence gathered in shadow mode: precision on results a person has
adjudicated, recall on seeded defects (an eval task that plants the defect),
and stability across repeated runs on the same tree. Metrics shows these per
item; `/devloop checklists promote <list>/<item>` needs a person.

## Where checklists fail, and what guards against it
- **Rubber-stamping**: every answer needs checked evidence; `unverified` is an
  allowed answer so that a reviewer is not pushed to guess.
- **False confidence**: presence is not quality. Items whose `verify.by` is
  `pattern` are reported as "present", never as "good".
- **Unbounded growth**: `maxItems`, and prune reports items that have never
  failed.
