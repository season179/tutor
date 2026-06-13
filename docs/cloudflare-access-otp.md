# Cloudflare Access OTP Setup

This protects `tutor.digitalvanguard.xyz` with Cloudflare Access so only allowlisted family emails can reach the backend.

## What This Configures

- A Cloudflare Access self-hosted application for `tutor.digitalvanguard.xyz`.
- A one-time PIN identity provider.
- An allow policy for exact family email addresses.
- No service tokens in the mobile app.

## Prerequisites

- `digitalvanguard.xyz` is managed by Cloudflare.
- Terraform is installed.
- A Cloudflare API token is available in `CLOUDFLARE_API_TOKEN`.
- The token can manage Zero Trust Access applications, policies, and identity providers for the account.

## Configure

Create a local tfvars file:

```sh
cp infra/cloudflare/access/terraform.tfvars.example infra/cloudflare/access/terraform.tfvars
```

Edit `infra/cloudflare/access/terraform.tfvars`:

```hcl
cloudflare_account_id = "your-cloudflare-account-id"

family_email_allowlist = [
  "parent@example.com",
  "student@example.com",
]
```

This file is ignored by git. To add or remove family members later, edit `family_email_allowlist` and re-apply Terraform.

## Apply

```sh
cd infra/cloudflare/access
terraform init
terraform plan
terraform apply
```

Save the `access_application_aud` output. The Worker should use it later to validate Cloudflare Access JWTs.

## Verify

After the Worker is deployed behind `tutor.digitalvanguard.xyz`:

- Open `https://tutor.digitalvanguard.xyz/health` in a browser.
- Confirm Cloudflare Access asks for a one-time PIN.
- Sign in with an allowlisted family email and confirm the health route loads.
- Try a non-allowlisted email and confirm access is denied.
- Confirm API clients without a valid Access session cannot call the session endpoint.

## Notes

Cloudflare Access service tokens are intentionally not used here because they require a client secret. A mobile app cannot safely keep that kind of secret.
