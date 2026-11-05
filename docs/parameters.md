# Personalize safely — five visible strings

Only [exercise/participant.json](../exercise/participant.json) is your parameter
file. Keep its exact five fields, quoted string values and valid JSON.

| Field | Initial example | Allowed / later change | Reject |
| --- | --- | --- | --- |
| `participant_name` | `alex` | Approved 2–12 lowercase letters/digits, first a letter; freeze before first deployment | `Alex`, `alex lee`, `alex_lee`, another learner's name, renaming live resources |
| `instance_number` | `001` | Fixed string, unchanged throughout | `002`, numeric `1`, `01` |
| `app_message` | `Hello from alex` | 1–60 letters/digits/spaces or `. , ! -`; e.g. `Updated by alex` | Blank, HTML/newlines, secrets or sensitive data |
| `page_theme` | `blue` | Exactly `blue`, `green`, `orange` | `purple`, `Blue`, arbitrary CSS |
| `workshop_iteration` | `01` | String `01`, `02`, `03`; safe update tag | Number `1`, `04`, name suffix changes |

Use your approved given name/workshop-safe alias, not a full legal name/email.
Names can appear in Azure and app URLs. Two `alex` learners in one scope need a
reviewed alternative such as `alexl` **before the first run**, not an automatic
hash or a per-push random name. Global app/storage availability is a real owner
check; a syntactically valid name is not guaranteed free.

| Object | Derived name for `alex` |
| --- | --- |
| Terraform-owned group | `rg-alex-001` |
| VNet / NSG | `vnet-alex-001` / `nsg-alex-001` |
| Plan / app | `asp-alex-001` / `app-alex-001` |
| Integration / endpoint subnet | `snet-app-alex-001` / `snet-pe-alex-001` |
| Blob endpoint / container | `pep-blob-alex-001` / `cnt-alex-001` |
| Storage exception | `stalex001` — no hyphens; maximum 17 workshop characters |
| Required DNS exception | `privatelink.blob.core.windows.net` |

Do not change region, CIDRs, resource names, SKU, count, backend, identity, security,
references or enablement. Unknown fields/wrong types fail, rather than become
ignored Terraform-variable warnings. The owner assignment freezes name/scope.
`workshop_iteration = "02"` must **not** make a resource end in `002`.

Preview names without Azure: **Terminal → `npm run check:inputs`**. In Section 3,
the precise `purple` rejection must occur in **Learner checks → Validate participant
input**, then be corrected. **Workshop quality** still runs the valid baseline;
its green result cannot substitute for the learner job's intentional failure.

## Copilot techniques — Sections 2 and 3 only

Participants already have GitHub Copilot licenses. Use your existing authorized
account in desktop VS Code; there is no purchase, premium-model choice, additional
seat, successful chat request or AI-usage submission required for this workshop.
Only the first **three existing steps** of Sections **2 and 3** contain Copilot
activities. Sections 1 and 4 have no Copilot tasks. The course remains four steps
per section and exactly three human section-transition comments.

### Standard routine for each optional activity

1. **Context:** open Chat in VS Code. Use **Ask**, if offered, or a read-only/no-tools
	session. If your interface cannot offer that safely, take the fallback instead.
	Use **Add Context → Files**, drag the named files into Chat, or select their
	`#`-mentions. Check the attachment chips; merely opening a file is not explicit
	context. Attach only the named workshop source files and sanitized error text.
2. **Goal + constraints + output:** copy the lesson's prompt. Request one small
	JSON/HCL response or explanation, preserve approved name/001 and supplied
	architecture, and explicitly request **no file changes, commands or tools**.
	In Section 2, replace “my approved name” in the prompt with your assigned
	lowercase alias; do not ask the model to guess it. In Section 3, keep the
	existing approved name from the file exactly.
	Do not use Agent/Edit mode, grant auto-approval or ask Chat to sign in, merge,
	deploy, change roles/guards, read live state or run cleanup.
3. **Review and iterate:** compare every suggestion with the lesson's expected
	answer. Ask at most one focused clarification, such as “keep the existing name
	and remove the extra field”. Timebox this to **two minutes per activity**; a
	limit, sign-in problem, slow response, bad answer or unavailable Copilot means
	use the fallback immediately—not troubleshoot licensing during the lab.
4. **Apply only the intended result, then test:** manually copy the reviewed JSON
	or the supplied fallback into the parameter file. Read-only HCL/flow examples
	are for comparison, not duplicate resources or workflow changes. Inspect the
	Git diff, run `npm run check:inputs`, then follow the lesson's commit/PR/checks
	sequence. The intentional purple test must fail and receive its receipt before
	the green fix. Neither a plausible answer nor a green source-quality job
	replaces the actual learner/current-revision/live evidence.

Never attach tokens, device codes, private logs, owner assignments/profiles, plans,
state, actual resource inventories or cleanup authorization. Public workshop code
and nonsecret parameter examples are sufficient. Keep any actual IDs privately
for the real verification steps, outside Chat and public issues.

### Six activities and their equally valid no-Copilot path

| Existing step | Technique and context | Expected/fallback result |
| --- | --- | --- |
| Section 2, step 1 | Constrained JSON generation from participant input and these rules | Copy that lesson's complete initial five-string JSON; replace both name placeholders; blue/01/001 |
| Section 2, step 2 | Generate/review one supplied RG block with local names/location/tags | Read/copy the displayed block for comparison; it already exists, so do not edit or duplicate Terraform |
| Section 2, step 3 | Explain the existing delivery workflow and responsibility boundaries | Read the supplied checks → admission → saved plan → exact apply → package → verification sequence |
| Section 3, step 1 | Reason about stable naming before an update | Read the fixed-name/001, same-root/state checklist; no edit yet |
| Section 3, step 2 | Diagnose the precise sanitized purple-theme rejection | Copy only the displayed theme line into the existing JSON; expected error is `page_theme must be blue, green or orange` |
| Section 3, step 3 | Produce a minimal correction, review its diff, validate | Copy the complete green/02/Updated-by JSON using the unchanged baseline name/001 |

**Both paths have identical completion criteria.** No extra branch, AI-generated
commit, transcript, screenshot, Copilot badge, prompt answer, license check or
manual evidence form is graded. A participant who never opens Chat can complete
the same course with the supplied answers. This does not bypass instructor live
readiness: source/templates/ordinary new copies still cannot deploy.

The examples are reviewed workshop reference answers, **not claims of an actual
model session or guaranteed Copilot output**. Learn the technique even when taking
the fallback: identify context and constraints, inspect the expected result, review
the diff and run the same checks.

Official references: [Copilot best practices](https://docs.github.com/en/copilot/get-started/best-practices),
[explicit file context](https://code.visualstudio.com/docs/chat/copilot-chat-context)
and [chat/review mechanics](https://code.visualstudio.com/docs/chat/chat-overview).
