# WS2 · Terraform → GitHub Actions → your Azure environment

**One repository. One laboratory. Four short sections.** Learn Git, YAML and
GitHub Actions with AgentAlvine, then use an owner-approved Azure route to create,
update and remove a personal **RG + VNet + private Blob storage + B1 web app**.

> **Source template: no Azure deployment.** Source maintenance uses **dev**.
> Your ordinary private copy can complete Section 1 offline. Sections 2–4 require
> a separately authorized private writer, permissions, budget and private connectivity;
> this source or a new copy never becomes eligible by setting a flag.

## Start here

1. Complete [accounts and workstation setup](docs/start-here.md).
2. Ask the instructor for **one private Enterprise-owned copy**, its enrolled
   account and approved name; do not work in this template or make four copies.
3. Clone **your copy's Code → HTTPS URL**, open it in desktop VS Code and run
   the read-only [doctor](docs/start-here.md#check-the-clone).
4. Open **Issues → Exercise**. AgentAlvine updates the **same issue body** as
   actual work/checks complete. It waits after each section for your exact comment:
   **`proceed to next section`**. There are three transitions, no per-step command.

| Section | Four guided steps | Target |
| --- | --- | --- |
| **1. Git and YAML checks** | Clone/branch → author checks → open PR → inspect CI | 35 min |
| **2. Create your environment** | Generate inputs → review IaC/PR → trace/observe delivery → inspect Azure/page | 45 min |
| **3. Update without renaming** | Reason from baseline → diagnose purple → fix/test/deploy → verify same IDs | 40 min |
| **4. Verify and remove your RG** | Inventory → no-change → authorized cleanup → verify absence | 40 min |

Timing is an estimate, **not measured beginner completion**. Allow about three
hours plus advance setup/pauses. Pausing the issue does not pause Azure billing.

## Copilot helps; it never blocks completion

Use the participants' existing licenses for **three optional techniques in
Section 2 and three in Section 3**. Each existing step supplies an exact JSON/HCL
answer, diagnosis or flow/checklist when Copilot is unavailable or unhelpful.
Follow the [context → constrained prompt → review → test routine](docs/parameters.md#copilot-techniques--sections-2-and-3-only).
No AI usage, license, model, transcript or screenshot is graded. Sections 1/4 have
no Copilot tasks; either path keeps the same sixteen gates and three transitions.

## Your name goes in one place

Edit [exercise/participant.json](exercise/participant.json), following the
[allowed parameters](docs/parameters.md). Example `alex` produces
`rg-alex-001`, `vnet-alex-001`, `asp-alex-001`, `app-alex-001` and **`stalex001`**
(storage cannot contain hyphens). The suffix stays `001`; iteration `02` is a tag,
not a rename. Names must be reserved/available before the first live run.

The [architecture](docs/architecture.md) and readable [Terraform root](infra)
include the RG in state. Only separately authorized full cleanup removes it,
**RG last**; shared backend/identities/runner remain outside its ownership.

## Review or teach

- [Complete four-section content](full-ws-content/README.md) · [recovery](docs/recovery.md)
- [Instructor setup and hard live boundary](docs/instructor-setup.md)
- [Verification evidence and limitations](docs/verification.md)
- [Image attribution](docs/images/NOTICE.md) · [today's work report](docs/daily%20work%20report/2026-11-05.md)

Local checks use Node **24.16.0**, Terraform **1.16.1**, AzureRM **5.4.0**, real
provider schemas and mocked operations. **Mocks, previews, screenshots and issue
progress are not Azure deployment permission or proof of a real cloud result.**
