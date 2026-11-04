# Web: B1 is the smallest Basic tier for this connected Linux example, not free.
resource "azurerm_service_plan" "workshop" {
  name                = local.names.plan
  location            = azurerm_resource_group.workshop.location
  resource_group_name = azurerm_resource_group.workshop.name
  os_type             = "Linux"
  sku_name            = "B1"
  worker_count        = 1
  tags                = local.tags
}

resource "azurerm_linux_web_app" "workshop" {
  name                                           = local.names.app
  location                                       = azurerm_resource_group.workshop.location
  resource_group_name                            = azurerm_resource_group.workshop.name
  service_plan_id                                = azurerm_service_plan.workshop.id
  virtual_network_subnet_id                      = azurerm_subnet.app.id
  https_only                                     = true
  public_network_access_enabled                  = true
  ftp_publish_basic_authentication_enabled       = false
  webdeploy_publish_basic_authentication_enabled = false
  tags                                           = local.tags

  identity {
    type         = "UserAssigned"
    identity_ids = [var.assignment.app_identity_id]
  }

  site_config {
    always_on                         = true
    minimum_tls_version               = "1.2"
    scm_minimum_tls_version           = "1.2"
    ftps_state                        = "Disabled"
    http2_enabled                     = true
    app_command_line                  = "npm start"
    vnet_route_all_enabled            = false
    remote_debugging_enabled          = false
    ip_restriction_default_action     = "Deny"
    scm_ip_restriction_default_action = "Deny"
    scm_use_main_ip_restriction       = true

    ip_restriction {
      name       = "approved-workshop-network"
      ip_address = var.assignment.allowed_web_cidr
      action     = "Allow"
      priority   = 100
    }

    application_stack {
      node_version = "24-lts"
    }
  }

  app_settings = {
    APP_MESSAGE                  = var.app_message
    PAGE_THEME                   = var.page_theme
    WORKSHOP_ITERATION           = var.workshop_iteration
    STORAGE_ACCOUNT_NAME         = azurerm_storage_account.workshop.name
    STORAGE_CONTAINER_NAME       = azurerm_storage_container.workshop.name
    MANAGED_IDENTITY_RESOURCE_ID = var.assignment.app_identity_id
    WEBSITE_RUN_FROM_PACKAGE     = "1"
  }
  depends_on = [azurerm_subnet_network_security_group_association.app]
}
