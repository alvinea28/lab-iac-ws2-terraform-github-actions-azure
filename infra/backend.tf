terraform {
  # Filled only by the approved main workflow. Offline checks disable the backend.
  backend "azurerm" {
    use_oidc         = true
    use_azuread_auth = true
  }
}
