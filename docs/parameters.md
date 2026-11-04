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
