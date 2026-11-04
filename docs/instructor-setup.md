# Instructor setup — a real gate, not another learner exercise

## 1. Keep this source and ordinary copies offline

This source is **ineligible for Azure**, even if someone sets an enablement flag.
Only the two immutable existing private simulation identities in
[deployment authorization](../scripts/deployment-authorization.cjs) can enter its
current live route. They are **not automatically approved for this new RG/B1/
storage profile, new environments, roles or spending**. No existing private
simulation/settings is migrated or changed by this source publication.

A new private class copy must not repin its identity to impersonate one of them.
Any expanded admission requires a separate owner-approved implementation/review
and actual readiness verification. Both `WORKSHOP_AZURE_ENABLED` and
`WORKSHOP_RG_CREATION_APPROVED` remain false/unset until that process completes.

## 2. Prepare before starting a live course cycle

- Confirm individual GitHub Enterprise accounts/SSO/MFA, repository licensing,
  actual access and owner-managed `WORKSHOP_LEARNER_USER_IDS` (JSON numeric IDs).
  Do not use a shared admin. Set enrollment before private startup; otherwise the
  guide stays setup-blocked. Git author metadata is not access proof.
- Choose an authorized sandbox, exact tenant/subscription/region, a unique approved
  participant name and network slot. Check `app-name-001` and `stname001` global
  availability and absence of an existing target RG; do not adopt/import it.
- Obtain explicit **currency/budget, maximum lifetime and cleanup owner**. B1,
  storage/transactions, private endpoint/DNS and private-runner/access costs apply.
  B1 bills while idle or stopped. A budget field/alert is **not a hard spending cap**.
- Creating a new RG needs authority beyond an old RG-scoped Contributor grant.
  Prefer an existing isolated training subscription per learner with reviewed
  minimum actions. A shared subscription needs a separately verified constrained
  creation/bootstrap design, not blanket subscription Contributor/Owner.
- Keep backend, OIDC/managed identity, runner and shared DNS outside the owned RG
  **and deployment authority**. Different RG names or state keys are not isolation.
  Inspect inherited policy/effective settings; no public-access or larger-SKU fallback.
- Precreate the exact app user-assigned identity and grant only its data-read scope
  through the separately authorized owner lane after the new account/scope exists,
  or demonstrate an equivalent isolated permission model. The learner pipeline
  cannot grant roles. Test actual propagation and App Service worker Blob access.
- Prepare Entra/OIDC-authenticated private Blob remote state with isolated backend
  permissions, recovery and lease locking. Verify the trusted runner's DNS/routes,
  app/SCM HTTPS access CIDR, Blob private data path and actual enrolled browser path.
- Register required providers as owner prework. The workflow never registers them.
  Verify **B1/Linux/one instance**, LRS and the region's quota/capacity; never substitute
  Free F1 (no required VNet integration), a bigger tier or unrestricted networking.

## 3. Protected main, runners and environments

Before a live Exercise cycle starts, prepare **existing protected main** with strict
current required checks, PR association, resolved threads and no force/deletion/bypass.
Only the exact approved automatic route permits author merge with zero required
approving reviews and no independent deployment reviewer. Respect stricter inherited
policy elsewhere rather than removing it.

Use the literal **workshop-plan** and **workshop-apply** environments, main-only custom
branch policy, no administrator bypass and no deployment reviewer/timer for the exact
approved route. These are **new profile names**, not silent changes to old environments.
Pin the real owner/admin-read ruleset ID, server `updated_at`, explicit empty bypass
list and readback time; a read-only token hiding `bypass_actors` is not proof of `[]`.

Restrict ephemeral **ws2-trusted** Linux runners to the exact protected delivery and
cleanup workflows. A runner label alone is not isolation. PRs run only on hosted
unprivileged runners with read-only tokens, no Azure/OIDC/secrets/backend.

## 4. Owner profile and immutable control/package pins

[assignment.example.json](../workshop/assignment.example.json) is deliberately
**offline/fake**, including the documentation-only web CIDR. It cannot authorize
live work. Prepare a real owner profile from the exact schema documented in
[deployment-authorization.cjs](../scripts/deployment-authorization.cjs), not a learner
edited file or an Action input. Keep actual assignments/private readbacks out of
this template and public issues.

| Protected configuration | Purpose |
| --- | --- |
| `WORKSHOP_OWNER_PROFILE_JSON` / `WORKSHOP_OWNER_PROFILE_SHA256` | Exact reviewed profile/assignment, scope, identities, immutable repo ID, ruleset/environment evidence, budget and active bounded lifetime |
| `WORKSHOP_CONTROL_SHA256_JSON` | Exact `controlDigests()` map checked **before importing repository control code**; not computed from learner input to bless itself |
| Scope/backend/plan+apply client variables listed by the helper | Independent fixed inputs, matched to the profile; Entra/OIDC only, no account key/client secret |
| `PLAN_ENCRYPTION_PUBLIC_KEY` | RSA ≥3072 public key; only ciphertext is uploaded |
| `PLAN_DECRYPTION_PRIVATE_KEY` | **Apply-environment secret only**; never print, commit, share through chat or expose to PR/plan jobs |
| `WORKSHOP_LEARNER_USER_IDS` | Frozen enrolled human IDs with verified current repository access |

The profile includes **explicit owner-verified `oidcSubjects.plan` and `.apply`**.
Capture the actual claims safely through the owner process: newer immutable subject
formats differ from old name-only subjects. Do not guess or automatically fall back.
Issuer/audience/repo ID/name/environment/main/SHA/run/attempt/expiry are also checked.

Pin original checked-out HCL/lock/workflow/control bytes and the **actual deterministic
ZIP**, using [package-app.mjs](../scripts/package-app.mjs) and the
[driver digest APIs](../scripts/delivery.mjs). Generate/review production pins in the
intended trusted Linux runtime; Windows line endings/optional packages can differ.
Dependencies install from exact npm locks without lifecycle scripts. Recheck all
pins when changing controls, package, infra, provider lock or workflows—do not
recalculate from whatever a learner pushed and call that authorization.

Repository admins can change code and variables: these checks are not a security
boundary against a malicious admin. Real cloud permissions, protected configuration,
reviewed trust and private runner/state isolation are still required.

## 5. Real run, followup and dedicated cleanup

An authorized checks-passing merge produces **push/main → same-SHA validation →
fresh plan → encrypted same-run artifact → exact saved-plan apply → pinned app ZIP
deployment → real ARM/HTTP/managed-identity Blob verification**. No second Deploy
button or human plan-review wait is added. Replanning during apply, reruns, stale
main, changed bindings or a plan older than two hours are rejected.

Delivery's manual input is **followup only**. Cleanup is the separate workflow on
main, dispatched by the current authenticated repository admin using its exact
scope-bound `authorization` input. The [cleanup workflow](../.github/workflows/cleanup.yml)
and guard bind `destroy:<repository ID>:<current full main SHA>:<state-lock ID>`;
this command is not an Azure secret or a replacement for owner cleanup authority.

Cleanup rechecks native state **and full actual inventory**, including correlated
endpoint/DNS platform children. Unknown/unrelated/shared resources stop it. Keep
nonempty-RG deletion protection and detach dependencies; no force-delete/unlock.
Remove the billable plan and owned RG last; verify known-scope ARM absence and
empty managed state. Retain external bootstrap and account for its costs.

The guide observes trusted readback steps after actual checks; it does not prove a
human clicked the portal. Three `proceed to next section` comments only navigate
the issue. They never enable, merge, approve, deploy or destroy anything.
