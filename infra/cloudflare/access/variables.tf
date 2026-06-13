variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Zero Trust Access configuration."
  type        = string

  validation {
    condition     = length(trimspace(var.cloudflare_account_id)) > 0
    error_message = "cloudflare_account_id is required."
  }
}

variable "tutor_domain" {
  description = "Domain protected by Cloudflare Access for the tutor backend."
  type        = string
  default     = "tutor.digitalvanguard.xyz"
}

variable "family_email_allowlist" {
  description = "Exact family email addresses allowed to authenticate with one-time PIN."
  type        = set(string)

  validation {
    condition     = length(var.family_email_allowlist) > 0
    error_message = "At least one family email address is required."
  }
}

variable "access_session_duration" {
  description = "How long Cloudflare Access sessions stay valid before re-authentication."
  type        = string
  default     = "24h"
}
