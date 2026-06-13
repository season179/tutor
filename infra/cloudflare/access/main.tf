terraform {
  required_version = ">= 1.6.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {}

resource "cloudflare_zero_trust_access_identity_provider" "one_time_pin" {
  account_id = var.cloudflare_account_id
  name       = "Tutor one-time PIN"
  type       = "onetimepin"
  config     = {}
}

resource "cloudflare_zero_trust_access_policy" "family_allowlist" {
  account_id = var.cloudflare_account_id
  name       = "Tutor family email allowlist"
  decision   = "allow"

  include = [
    for email in sort(tolist(var.family_email_allowlist)) : {
      email = {
        email = email
      }
    }
  ]

  require = [{
    login_method = {
      id = cloudflare_zero_trust_access_identity_provider.one_time_pin.id
    }
  }]
}

resource "cloudflare_zero_trust_access_application" "tutor_backend" {
  account_id                 = var.cloudflare_account_id
  name                       = "Tutor backend"
  domain                     = var.tutor_domain
  type                       = "self_hosted"
  session_duration           = var.access_session_duration
  app_launcher_visible       = false
  auto_redirect_to_identity  = true
  http_only_cookie_attribute = true
  same_site_cookie_attribute = "lax"
  allowed_idps               = [cloudflare_zero_trust_access_identity_provider.one_time_pin.id]

  policies = [{
    id = cloudflare_zero_trust_access_policy.family_allowlist.id
  }]
}
