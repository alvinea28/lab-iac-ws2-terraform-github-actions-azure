# What verification means in this source

## Authoring checks

- Node's built-in runner covers exact input/naming rejection, cryptography and
  tampering, plan scope/SKU/security, current-main admission, guide boundaries/
  replay/history, native-driver adapters, ARM/HTTP fixtures and local app HTTP.
- Terraform **1.16.1** downloads the signed **AzureRM 5.4.0** provider and inspects
  its real schema. A disposable root omits the backend, scrubs cloud/token variables
  and runs `validate` plus provider-**mocked** topology/update/rejection cases.
  The checked-in provider lock includes Windows/Linux hashes. No tests initialize
  the real backend or deploy Azure.
- Lint actual installed workflows and the learner reference with **actionlint
  1.7.12**. Content checks verify 16 concise complete lessons, mirrors, links,
  image manifest, step labels and pinned action references.
- The supplied app is tested over actual local HTTP with injected Blob probes;
  missing Azure settings produce **pending**, not fabricated private access.
- Sections 2/3 contain exactly three optional Copilot techniques each. Content/input
  regressions exercise the published copyable examples and read-only HCL reference.
  Full-course synthetic regressions load all sixteen real lessons and compare
  reviewed assisted candidates with copy/manual continuation through the same
  rejection, fix, three pauses, saved-run verification and final absence gates.
  They invoke **no model**, inspect no license/usage and require no transcript.

`npm run check` is the composite credential-free content/schema/mocks/package check.
`npm test` executes the Node suites. `node scripts/preview.mjs` serves the local
learning/parameter views; it neither signs in nor deploys.

## Honest boundaries

This source publication is **not** a real two-participant Azure rehearsal. Synthetic
GitHub API fixtures exercise the whole guide, including the three exact comments,
but do not establish that a new private copy's real enrollment, issue events or
Enterprise permissions are configured. Source Preview stays read-only and ungraded.

Real source CI/Preview URLs and final local counts are recorded in the
[daily report](daily%20work%20report/2026-11-05.md) after publication. Do not treat
old scrollback, skipped jobs or a different commit's run as current proof.

Live readiness, provider/region capacity, RG/RBAC/bootstrap grants, actual OIDC
claims, private runner/SCM/Blob networking, billing and create/update/no-change/
full-RG cleanup remain separately authorized instructor work. Only actual runtime
readbacks can establish them; reference screenshots never do.
