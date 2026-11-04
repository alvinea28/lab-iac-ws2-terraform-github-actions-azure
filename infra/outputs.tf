output "resource_group_id" {
  description = "The exact Terraform-owned group; cleanup must verify this scope."
  value       = azurerm_resource_group.workshop.id
}

output "resource_group_name" {
  description = "The participant-named resource group."
  value       = azurerm_resource_group.workshop.name
}

output "web_app_id" {
  description = "App identity for verification; the URL is returned by Azure, not guessed."
  value       = azurerm_linux_web_app.workshop.id
}

output "app_url" {
  description = "Actual default hostname. Private-ingress policy may require a different approved profile."
  value       = "https://${azurerm_linux_web_app.workshop.default_hostname}"
}

output "storage_account_id" {
  description = "Workload storage, never the Terraform backend."
  value       = azurerm_storage_account.workshop.id
}

output "owned_names" {
  description = "A non-secret name preview; names alone are not authorization."
  value       = local.names
}
