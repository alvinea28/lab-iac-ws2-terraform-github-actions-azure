provider "azurerm" {
  features {
    resource_group {
      prevent_deletion_if_contains_resources = true
    }
  }

  subscription_id                 = var.assignment.subscription_id
  tenant_id                       = var.assignment.tenant_id
  use_oidc                        = true
  use_cli                         = false
  storage_use_azuread             = true
  resource_provider_registrations = "none"
}
