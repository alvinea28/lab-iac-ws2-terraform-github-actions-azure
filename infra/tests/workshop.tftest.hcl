# Real provider schema, mocked operations: no Azure credentials, state or calls.
mock_provider "azurerm" {
  mock_resource "azurerm_resource_group" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001" }
  }
  mock_resource "azurerm_virtual_network" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001/providers/Microsoft.Network/virtualNetworks/vnet-alex-001" }
  }
  mock_resource "azurerm_subnet" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001/providers/Microsoft.Network/virtualNetworks/vnet-alex-001/subnets/snet-app-alex-001" }
  }
  mock_resource "azurerm_network_security_group" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001/providers/Microsoft.Network/networkSecurityGroups/nsg-alex-001" }
  }
  mock_resource "azurerm_storage_account" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001/providers/Microsoft.Storage/storageAccounts/stalex001" }
  }
  mock_resource "azurerm_private_dns_zone" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001/providers/Microsoft.Network/privateDnsZones/privatelink.blob.core.windows.net" }
  }
  mock_resource "azurerm_service_plan" {
    defaults = { id = "/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/rg-alex-001/providers/Microsoft.Web/serverfarms/asp-alex-001" }
  }
  mock_resource "azurerm_linux_web_app" {
    defaults = { default_hostname = "app-alex-001.example.invalid" }
  }
}

run "create_personal_connected_blueprint" {
  command = plan

  assert {
    condition     = azurerm_resource_group.workshop.name == "rg-alex-001" && azurerm_virtual_network.workshop.name == "vnet-alex-001"
    error_message = "The root must create the exact participant-named RG and VNet."
  }
  assert {
    condition     = azurerm_service_plan.workshop.sku_name == "B1" && azurerm_service_plan.workshop.os_type == "Linux" && azurerm_service_plan.workshop.worker_count == 1
    error_message = "Use the single-instance Linux Basic B1 profile."
  }
  assert {
    condition     = azurerm_storage_account.workshop.name == "stalex001" && azurerm_storage_account.workshop.account_replication_type == "LRS" && !azurerm_storage_account.workshop.public_network_access_enabled && !azurerm_storage_account.workshop.shared_access_key_enabled && !azurerm_storage_account.workshop.allow_nested_items_to_be_public
    error_message = "Private LRS Blob storage must use the Azure-compliant name and no shared/anonymous access."
  }
  assert {
    condition     = azurerm_subnet.app.address_prefixes == tolist(["10.80.21.0/26"]) && azurerm_subnet.endpoints.address_prefixes == tolist(["10.80.21.64/27"])
    error_message = "Integration and private endpoint subnets must remain separate."
  }
  assert {
    condition     = azurerm_linux_web_app.workshop.https_only && azurerm_linux_web_app.workshop.site_config[0].ip_restriction_default_action == "Deny" && azurerm_linux_web_app.workshop.site_config[0].scm_use_main_ip_restriction
    error_message = "Web/SCM HTTPS access must retain the approved-network restrictions."
  }
}

run "update_message_theme_iteration_without_renaming" {
  command = plan
  variables {
    app_message        = "Updated by alex"
    page_theme         = "green"
    workshop_iteration = "02"
  }
  assert {
    condition     = azurerm_resource_group.workshop.name == "rg-alex-001" && azurerm_linux_web_app.workshop.name == "app-alex-001" && azurerm_storage_account.workshop.name == "stalex001"
    error_message = "A safe update must not rename the RG, app or storage account."
  }
  assert {
    condition     = azurerm_linux_web_app.workshop.app_settings["PAGE_THEME"] == "green" && azurerm_linux_web_app.workshop.app_settings["APP_MESSAGE"] == "Updated by alex" && azurerm_resource_group.workshop.tags["workshop_iteration"] == "02"
    error_message = "The update must reach app settings and tags."
  }
}

run "reject_uppercase_participant" {
  command = plan
  variables { participant_name = "Alex" }
  expect_failures = [var.participant_name]
}

run "reject_other_participant" {
  command = plan
  variables { participant_name = "alexl" }
  expect_failures = [var.participant_name]
}

run "reject_changed_instance" {
  command = plan
  variables { instance_number = "002" }
  expect_failures = [var.instance_number]
}

run "reject_purple_theme" {
  command = plan
  variables { page_theme = "purple" }
  expect_failures = [var.page_theme]
}

run "reject_html_message" {
  command = plan
  variables { app_message = "<b>unsafe</b>" }
  expect_failures = [var.app_message]
}

run "reject_blank_message" {
  command = plan
  variables { app_message = "   " }
  expect_failures = [var.app_message]
}

run "reject_overlong_message" {
  command = plan
  variables { app_message = "This message deliberately exceeds sixty characters and must be rejected." }
  expect_failures = [var.app_message]
}

run "reject_unknown_iteration" {
  command = plan
  variables { workshop_iteration = "04" }
  expect_failures = [var.workshop_iteration]
}
