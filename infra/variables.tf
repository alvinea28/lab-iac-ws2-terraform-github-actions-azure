variable "participant_name" {
  type        = string
  description = "Your approved lowercase given name/workshop alias, frozen before the first deployment."

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,11}$", var.participant_name)) && var.participant_name == var.assignment.participant_name
    error_message = "Use the assigned 2-12 character lowercase name; do not rename a deployed environment."
  }
}

variable "instance_number" {
  type        = string
  description = "Fixed name suffix. Updating the workshop does not change 001 to 002."

  validation {
    condition     = var.instance_number == "001"
    error_message = "instance_number must remain the string 001."
  }
}

variable "app_message" {
  type        = string
  description = "Non-sensitive welcome message displayed by the supplied app."

  validation {
    condition     = can(regex("^[A-Za-z0-9 .,!-]{1,60}$", var.app_message)) && length(trimspace(var.app_message)) > 0
    error_message = "Use 1-60 plain-text characters: letters, digits, spaces or . , ! -; no HTML, newlines or secrets."
  }
}

variable "page_theme" {
  type        = string
  description = "Welcome-page color. Only the supplied safe CSS themes are allowed."

  validation {
    condition     = contains(["blue", "green", "orange"], var.page_theme)
    error_message = "page_theme must be blue, green or orange."
  }
}

variable "workshop_iteration" {
  type        = string
  description = "A safe update tag, not a resource name or deployment counter."

  validation {
    condition     = contains(["01", "02", "03"], var.workshop_iteration)
    error_message = "workshop_iteration must be the string 01, 02 or 03."
  }
}

variable "assignment" {
  description = "Owner-reviewed infrastructure bindings; the learner input file cannot override this object."
  type = object({
    participant_name = string
    subscription_id  = string
    tenant_id        = string
    location         = string
    allowed_web_cidr = string
    network_slot     = number
    app_identity_id  = string
    owner            = string
    cost_center      = string
    expires_at       = string
  })

  validation {
    condition     = var.assignment.network_slot >= 0 && var.assignment.network_slot <= 199 && floor(var.assignment.network_slot) == var.assignment.network_slot
    error_message = "The instructor must assign a network slot from 0 to 199."
  }

  validation {
    condition     = can(cidrnetmask(var.assignment.allowed_web_cidr)) && try(tonumber(split("/", var.assignment.allowed_web_cidr)[1]) > 0, false)
    error_message = "The instructor must supply a restricted IPv4 web access CIDR, never 0.0.0.0/0."
  }

  validation {
    condition     = can(regex("^/subscriptions/[a-fA-F0-9-]+/resourceGroups/[^/]+/providers/Microsoft.ManagedIdentity/userAssignedIdentities/[A-Za-z0-9_-]+$", var.assignment.app_identity_id)) && !strcontains(lower(var.assignment.app_identity_id), "/resourcegroups/rg-${var.assignment.participant_name}-001/")
    error_message = "Use the owner's existing app identity outside this Terraform-owned workload RG."
  }
}
