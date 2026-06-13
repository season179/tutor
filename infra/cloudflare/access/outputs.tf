output "access_application_id" {
  description = "Cloudflare Access application ID for tutor.digitalvanguard.xyz."
  value       = cloudflare_zero_trust_access_application.tutor_backend.id
}

output "access_application_aud" {
  description = "Cloudflare Access AUD value. Use this when validating Access JWTs in the Worker."
  value       = cloudflare_zero_trust_access_application.tutor_backend.aud
}

output "one_time_pin_identity_provider_id" {
  description = "Cloudflare Access identity provider ID for the one-time PIN login method."
  value       = cloudflare_zero_trust_access_identity_provider.one_time_pin.id
}
