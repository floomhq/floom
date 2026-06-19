output "region" {
  value = var.region
}

output "ecr_repository_url" {
  description = "Push the cloud image here before apply (docker push <this>:<tag>)."
  value       = aws_ecr_repository.app.repository_url
}

output "alb_dns_name" {
  description = "Public hostname for the web API. Point workeros-api.floom.dev at this (CNAME) once verified."
  value       = aws_lb.web.dns_name
}

output "cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "web_service_name" {
  value = aws_ecs_service.web.name
}

output "worker_service_name" {
  value = aws_ecs_service.worker.name
}
