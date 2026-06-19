# workeros-aws — ECS Fargate deploy (compute on AWS, state on Supabase)

Deploys the WorkerOS cloud as two Fargate services in **eu-central-1** (co-located
with Supabase), keeping **Supabase** for DB/auth/storage and **E2B** for sandboxes:

- **web** — the FastAPI API behind an ALB (`WORKEROS_ROLE=web`)
- **worker** — the run-executor/drain loop, no load balancer (`WORKEROS_ROLE=worker`)

Tasks run in the **default VPC's public subnets with public IPs** (no NAT gateway →
cheaper) and open egress, so they can reach **E2B, Gemini AI Studio, Supabase, and
Bedrock** (all external HTTPS). Bedrock LLM calls can target `us-east-1` (125 models)
regardless of compute region.

## NOT ready to apply yet — prerequisites
1. **Engine #1531** (the `WORKEROS_ROLE` web/worker split + worker entrypoint) must be
   merged + in the image, or the `worker` service crash-loops. **Until then set
   `worker_desired_count = 0`** (the example tfvars does). Web works as-is.
2. **Image in ECR** — `terraform apply` creates the ECR repo; the image must be built
   from the cloud repo's Dockerfile and pushed (see below).
3. **Secrets populated** — copy `terraform.tfvars.example` → `secrets.auto.tfvars` and
   fill from your Railway env. NEVER commit it.
4. Match `app_port` to the port the image's uvicorn binds (default 8000).

## Who runs `apply` — keys

**Recommended: run it yourself with your own admin/SSO identity. No key needs to leave
your machine.** Terraform uses your local AWS credential chain.

The `claude-bedrock-bench` key you shared is **Bedrock-scoped and cannot deploy**
(ecs/ecr/elbv2/logs/ssm = AccessDenied) — and **should be rotated** (it's in chat).

If you want a **dedicated deploy identity** (e.g. for CI), create a least-privilege IAM
user/role with these services (one-time setup):

```
ec2:Describe*, ec2:*SecurityGroup*, ec2:CreateTags, ec2:DescribeNetworkInterfaces
ecr:* (on this repo) + ecr:GetAuthorizationToken
ecs:*
elasticloadbalancing:*
logs:CreateLogGroup, logs:PutRetentionPolicy, logs:Describe*, logs:DeleteLogGroup, logs:TagResource
ssm:PutParameter, ssm:GetParameter*, ssm:DeleteParameter, ssm:DescribeParameters, ssm:AddTagsToResource
iam:CreateRole, iam:DeleteRole, iam:GetRole, iam:Tag*, iam:AttachRolePolicy, iam:DetachRolePolicy,
iam:PutRolePolicy, iam:DeleteRolePolicy, iam:List*, iam:PassRole
```
(Pragmatic shortcut for a one-time manual deploy: a **temporary** user with
`AdministratorAccess`, used once, then **delete the access key**. Don't paste a broad
key into chat — run locally.)

## Deploy steps
```bash
# 0. auth (your own identity)
aws sso login           # or export AWS_PROFILE / keys locally

# 1. init + sanity
terraform init
terraform validate

# 2. secrets
cp terraform.tfvars.example secrets.auto.tfvars
$EDITOR secrets.auto.tfvars     # fill REPLACE values from Railway

# 3. create ECR + roles first (so we can push the image), then push it
terraform apply -target=aws_ecr_repository.app
ECR=$(terraform output -raw ecr_repository_url)
aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin "${ECR%/*}"
docker build -t "$ECR:latest" /path/to/workeros-cloud       # the cloud repo root
docker push "$ECR:latest"

# 4. full plan + apply
terraform plan
terraform apply

# 5. verify
curl http://$(terraform output -raw alb_dns_name)/healthz
```

Then point `workeros-api.floom.dev` (CNAME → ALB DNS), add an ACM cert + set
`acm_certificate_arn` for HTTPS, and cut traffic over from Railway last.

## Cost (credit-funded)
ALB ~$16/mo + Fargate (web 0.5vCPU/1GB, worker 1vCPU/2GB) ~$30-60/mo + CloudWatch.
No NAT gateway. ~$60-90/mo → $5k credits ≈ 4-6 years at this size.

## Hardening (after first green deploy)
- **Remote state**: switch to an S3 + DynamoDB backend (state holds secret values — keep
  it encrypted + off local disk). Uncomment the `backend "s3"` block in `providers.tf`.
- **HTTPS**: ACM cert + `acm_certificate_arn` + the `https` listener.
- **Rotate** the exposed `claude-bedrock-bench` key.
- Consider App Autoscaling on the web service once traffic justifies it.
