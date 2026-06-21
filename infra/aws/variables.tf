variable "region" {
  description = "Compute region. Keep == your Supabase region (eu-central-1) to avoid cross-region latency/egress + keep DACH PII in-region."
  type        = string
  default     = "eu-central-1"
}

variable "project" {
  type    = string
  default = "workeros"
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "app_port" {
  description = "Port the FastAPI/uvicorn container listens on. Must match the image's bind port."
  type        = number
  default     = 8000
}

variable "image_tag" {
  description = "ECR image tag to deploy (push the cloud image to the ECR repo this module creates)."
  type        = string
  default     = "latest"
}

# Fargate task sizing (must be a valid CPU/memory combo)
variable "web_cpu" {
  type    = string
  default = "512"
}
variable "web_memory" {
  type    = string
  default = "1024"
}
variable "worker_cpu" {
  type    = string
  default = "1024"
}
variable "worker_memory" {
  type    = string
  default = "2048"
}

variable "web_desired_count" {
  type    = number
  default = 1
}
variable "worker_desired_count" {
  description = "1 = run the env-driven worker (WORKEROS_ROLE=worker drain loop; engine + cloud lifespan are role-aware). 0 = disable (e.g. so a test stack does not drain a shared prod queue)."
  type        = number
  default     = 1
}

variable "health_check_path" {
  type    = string
  default = "/healthz"
}

variable "web_command" {
  description = "Override the web container CMD. Empty = use the image default (uvicorn)."
  type        = list(string)
  default     = []
}

variable "worker_command" {
  description = "Worker container CMD. Engine split is ENV-DRIVEN (WORKEROS_ROLE), no separate entrypoint -> use the image default CMD (uvicorn) with WORKEROS_ROLE=worker."
  type        = list(string)
  default     = []
}

variable "container_env" {
  description = "Non-secret env vars injected into BOTH services (e.g. WORKEROS_MAX_CONCURRENT_RUNS, template ids). WORKEROS_ROLE + PORT are set automatically."
  type        = map(string)
  default     = {}
}

variable "container_secrets" {
  description = "Secret env vars -> created as SSM SecureString and injected via valueFrom. Populate from your Railway env (Supabase keys, E2B keys, encryption key, lock-DB creds, LLM keys, AWS creds). NEVER commit real values."
  type        = map(string)
  default     = {}
  sensitive   = true
}

variable "acm_certificate_arn" {
  description = "Optional ACM cert ARN for HTTPS on the ALB (for workeros-api.floom.dev). Empty = HTTP-only on the ALB DNS for first validation."
  type        = string
  default     = ""
}

# --- Web autoscaling (see autoscaling.tf) -----------------------------------
variable "web_min_capacity" {
  description = "Minimum web tasks under autoscaling (>=2 for AZ HA)."
  type        = number
  default     = 2
}
variable "web_max_capacity" {
  description = "Maximum web tasks under autoscaling."
  type        = number
  default     = 8
}
variable "web_cpu_target" {
  description = "Target average CPU %% for the web service (scale-out trigger)."
  type        = number
  default     = 60
}
variable "web_alb_requests_target" {
  description = "Target ALB requests/min per web task (scale-out trigger)."
  type        = number
  default     = 400
}
