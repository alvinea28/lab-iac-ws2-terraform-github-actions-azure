# AgentAlvine · Full workshop lessons

One learner repository, one local clone, one **Exercise**, one owning Terraform root/state and one sequential environment. These pages mirror the sixteen guided lessons; reading them does not complete their evidence gates. AgentAlvine observes real GitHub metadata and keeps the current lesson in the same Exercise. It never grants Azure permission, merges a PR or dispatches delivery/cleanup.

## Start here

Complete [installation, account and private-copy preparation](../docs/start-here.md) before the timed sections; clone/open once in Step 1, reusing an existing assigned clone if present. Required: your **individual authorized GitHub Enterprise Cloud account with SSO/MFA**, Git, VS Code, Node 24.16.0, YAML authoring, GitHub Actions, Terraform 1.16.1/AzureRM 5.4.0 and authorized Azure hands-on access. GitHub Copilot is optional. Do not share an administrator account or treat sign-in/install screenshots as learner task evidence.

Use the assigned private copy, not the public source. Wait for AgentAlvine's course-start receipt before the first meaningful task-branch commit/push. Owner-managed enrollment and current repository access are prerequisites; neither an issue checkbox nor a pasted user name establishes enrollment.

For a live course cycle, the owner must have prepared the existing protected `main` and its required checks **before the cycle starts**. An ordinary offline copy may use default `dev` for Section 1. Keep that real PR history: do not later change its base to manufacture protected-main evidence. Arrange owner handoff and a reviewed course cycle/restart when ready; never edit the journal to reset progress.

## Four sections · four steps each

| Section | Lessons | Activity target |
| --- | --- | --- |
| 1 · Enterprise Git and YAML checks | [1 Push first check](s1-1.md) · [2 Install checks](s1-2.md) · [3 Open PR](s1-3.md) · [4 Inspect checks](s1-4.md) | 35 minutes |
| 2 · Name, inspect and create | [1 Approved inputs](s2-1.md) · [2 Inspect input PR](s2-2.md) · [3 Real delivery](s2-3.md) · [4 Environment verification](s2-4.md) | 45 minutes |
| 3 · Reject and safely update | [1 Baseline](s3-1.md) · [2 Purple rejection](s3-2.md) · [3 Green correction](s3-3.md) · [4 Unchanged identities](s3-4.md) | 40 minutes |
| 4 · Converge and separately clean up | [1 Owned inventory](s4-1.md) · [2 No-change](s4-2.md) · [3 Authorized cleanup](s4-3.md) · [4 Absence/retention](s4-4.md) | 40 minutes |

The 160-minute activity target is unmeasured; advance setup, cloud waits and pauses are additional. Sections 1–3 pause only after genuine **4/4** verification, keeping their fourth lesson visible. After the ready prompt, the enrolled human with current write access posts the exact comment printed in that lesson, in the same Exercise. There are exactly **three** transitions. Early comments are not queued; edited, replayed, outsider, bot or PR comments cannot substitute. A boundary comment only reveals the next section's first step; it never enables Azure or authorizes spending/deletion.

Section 4 has no fourth transition command. Genuine final absence verification completes/closes the Exercise while keeping the **entire final lesson and retention instructions visible**. No manual evidence PR, check command, checkbox update or fabricated review is required.

## Optional Copilot practice — only Sections 2 and 3

Participants already hold licenses. Follow the [standard context/prompt/review/test routine](../docs/parameters.md#copilot-techniques--sections-2-and-3-only)
in **steps 1–3 of Section 2 and steps 1–3 of Section 3**, never more than three
activities per section. The remaining steps and all of Sections 1/4 have no
Copilot task. There is no fifth step, AI grading or change to course history.

Section 2 practices constrained JSON generation, review of a supplied Terraform
resource and explanation of the delivery chain. Section 3 practices stable-name
reasoning, diagnosis of an intentional failure and a minimal validated correction.
Every activity includes **Fallback — no Copilot needed**: exact copyable expected
code/fix or a read-only checklist/answer. Chat may be skipped, blocked or exhausted;
do not wait for access or accept unrelated generated changes. The supplied HCL is
already implemented; compare it, never duplicate or modify protected infrastructure.

Both paths continue through the same initial input, actual checks/delivery, recorded
purple rejection, green update, same IDs, no-change and separately authorized cleanup.
Use the same owning clone/root/state and exactly three section comments; no prompt,
transcript, AI commit or license check is a prerequisite. Instructor cloud readiness
remains mandatory even when the authoring fallback is available.

## Know the five input strings

Read [parameters and valid examples](../docs/parameters.md); edit only [exercise/participant.json](../exercise/participant.json). Unknown/missing fields, wrong types and protected overrides reject. In lesson prose, replace `<name>` with the approved name; do not enter angle brackets into the JSON.

| Field | Valid initial example | Rule |
| --- | --- | --- |
| `participant_name` | `alex` | Approved reserved name/alias; 2–12 lowercase letters/digits, starting with a letter. Examples: `alexl`, `alex26`, `li`; not `Alex`, `alex-lee` or `123alex`. |
| `instance_number` | `001` | Fixed string, never a number or `002`. |
| `app_message` | `Hello from alex` | Nonblank 1–60 plain-text letters/digits/spaces or `. , ! -`; no HTML, newlines, secrets or sensitive data. Section 1 first uses `Ready for checks`. |
| `page_theme` | `blue` | Only `blue`, `green`, `orange`; Section 3 deliberately rejects `purple` before fixing to `green`. |
| `workshop_iteration` | `01` | String `01`, `02` or `03`; Section 3 uses `02`, not a new resource suffix. |

There are four editable values plus one visible fixed suffix. Freeze name/`001` before first apply. For approved `alex`, names include `rg-alex-001`, `vnet-alex-001`, `asp-alex-001`, `app-alex-001` and storage **`stalex001`**, not a hyphenated storage name. No hidden hash is appended. The Blob DNS zone remains `privatelink.blob.core.windows.net`; Azure-required default/GUID/platform-child names are exceptions. Name patterns do not prove global availability or access isolation. The owner reserves names and checks actual global app/storage availability **before deployment**; the initial target RG must be **absent**, not precreated, imported or overwritten.

Read, do not edit, the supplied [variables](../infra/variables.tf), [name/tag mapping](../infra/locals.tf), [Terraform-owned RG](../infra/resource-group.tf), [network](../infra/network.tf), [storage](../infra/storage.tf), [web](../infra/web.tf) and [safe outputs](../infra/outputs.tf). The [architecture](../docs/architecture.md) connects one VNet/two subnets/NSG, Linux Basic B1/one worker and StorageV2/Standard LRS/Hot private Blob with endpoint/DNS and managed-identity reads. The application and deployment wiring are supplied, not learner coding tasks.

## Live admission is not ordinary copy setup

**New ordinary copies support Section 1 offline only; live work remains pending.** Source maintenance/default `dev` pushes, public sources, public/private templates, forks and unapproved copies never deploy. Source and ordinary copies must retain `WORKSHOP_AZURE_ENABLED=false` and `WORKSHOP_RG_CREATION_APPROVED=false`; learners never edit enablement, eligibility/allowlists, roles, owner pins or bypass settings.

Only these two **existing** private, non-template identities are eligible for separately approved readiness—not two new repositories or permission to add identities:

| Immutable repository ID | Exact existing route |
| --- | --- |
| `1379147533` | `alvine-aurelio-org/ws2-sim-20260921-network-module-laboratory-02` |
| `1379149907` | `alvine-aurelio-org/ws2-sim-20260921-azure-delivery-laboratory-07` |

The owner must complete [instructor readiness](../docs/instructor-setup.md) before any live merge:

- Approve the exact participant, tenant/subscription, initially absent RG, region, inventory, B1/one-worker scope and new resource types. An existing private-identity profile does **not** automatically approve RG creation, new permissions or broader subscription rights.
- Verify constrained RG create/delete authority and isolation. Existing-RG Contributor cannot create a new RG; neither naming guards nor a different RG alone protect shared bootstrap. Do not hand learners subscription-wide Contributor/Owner or role-administration rights.
- Prepare scoped plan/apply OIDC identities, reviewed effective policy/quota and a separately authorized owner lane for the app's narrow Blob data role **after the new target scope exists**, with propagation verified. Learners cannot self-grant it.
- Verify isolated locked remote state, a single writer, expiring encrypted same-run plans, exact saved-plan bindings and trusted runner access to backend/private Blob/DNS and approved app/SCM ingress. Backend, UAMI, runner and shared platform scopes stay outside the workload RG **and its deployment authority**.
- Approve an explicit budget **currency and amount**, bounded lifetime and cleanup owner. Budget declarations are not billing caps. B1 bills while idle/stopped; private endpoint/DNS/storage/runner and retained bootstrap costs also matter. Pauses do not stop billing.
- Retain protected `main`, current required checks and no bypass. On this exact approved route, the PR author may merge after checks; no self-approval, separate approving PR reviewer or manual deployment approver is required. Bootstrap and cleanup still need their separate owner authorization.

False flags, a not-ready cloud, `standalone: false`, mocked tests or a source Preview cannot complete the four sections or earn live progress. Do not convert skipped jobs into success claims.

## Read the actual workflow contracts

Section 1 constructs one installed checks workflow from two outside-workflow inputs: [workflow-starter.yml](../exercise/workflow-starter.yml) and [validation-workflow.yml](../exercise/validation-workflow.yml). Use VS Code file tools to create the new learner workflow; its complete body must match the canonical reference, not include the starter comments. Preserve the supplied event/header and fill only the two command gaps. Do not install the outside buffers themselves as extra workflows.

| Workflow | Actual jobs/results to inspect |
| --- | --- |
| Learner checks | Validate workshop inputs → Validate participant input; current revision, genuine nonzero mocked tests, no Azure credentials. |
| [Workshop delivery](../.github/workflows/delivery.yml) | Validate reviewed workshop revision → Verify scoped workshop policy → Create encrypted workshop plan → Apply exact workshop plan → Package and deploy workshop app → Verify deployed workshop. |
| Delivery `followup` | Confirm no-change; fresh native exit `0`, no apply/cleanup. Exit `2` means differences, not permission to apply. |
| [Workshop cleanup](../.github/workflows/cleanup.yml) | Generic jobs Create encrypted workshop plan / Apply exact workshop plan; destroy-specific steps Create encrypted workshop destroy plan / Apply exact authorized workshop destroy plan; then Verify workload absence. |

Pre-merge inspection is the diff/current CI, **not** a live Azure plan. A permitted protected-main merge triggers validation, encryption and exact-plan apply automatically, then same-revision ZIP deployment and fresh actual ARM/HTTP/managed-identity private-Blob verification. Inspect safe action counts, run/revision bindings, hashes and returned `app_url`; never publish raw plans/state, credentials, private keys or actual cleanup authorization values. A guide receipt locates verified workflow evidence; it does not prove a human portal visit.

Cleanup is a separate current-admin dispatch, privately bound to `destroy:<repoID>:<currentfullmainSHA>:<WS2_STATE_LOCK_ID>`. Recheck actual RG inventory; unknown/unrelated/shared objects stop deletion. Apply the full authenticated saved destroy plan, children first and Terraform-owned RG last—no targeted destroy, forced RG deletion, lock removal or disabled nonempty-RG guards. Require actual known-RG ARM absence **and** empty managed workload state, while retaining and owner-verifying external bootstrap and grants. Use [recovery](../docs/recovery.md) whenever readiness/evidence is uncertain.

## Reference images are not learner evidence

The sixteen step images, two setup images and reusable boundary image form a nineteen-image reference/preview set. Their captions and [image notice](../docs/images/NOTICE.md) identify provenance; they do not prove participant activity, authentication, deployment or cleanup. Only the genuine current-course/current-revision evidence gates may advance the Exercise.
