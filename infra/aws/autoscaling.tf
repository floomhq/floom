# --- Web service horizontal autoscaling -------------------------------------
# Scales the stateless HTTP/API tier (WORKEROS_ROLE=web) horizontally behind the
# ALB. Worker code is rematerialized from Supabase _files per task and the data
# path is PostgREST/HTTP, so web tasks are interchangeable — safe to fan out.
#
# Two target-tracking policies (AWS scales out on whichever fires first, scales
# in only when BOTH are below target):
#   - CPU utilization (catches compute-bound bursts)
#   - ALB request count per target (catches request-rate bursts before CPU moves)
#
# Purely additive: introduces an appautoscaling target + policies. It does NOT
# modify the ECS service except to hand min/max control to Application Auto
# Scaling. `web_desired_count` becomes the floor only at first apply; thereafter
# autoscaling owns the running count between web_min_capacity and web_max_capacity.

resource "aws_appautoscaling_target" "web" {
  service_namespace  = "ecs"
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.web.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  min_capacity       = var.web_min_capacity
  max_capacity       = var.web_max_capacity
}

resource "aws_appautoscaling_policy" "web_cpu" {
  name               = "${local.name}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = var.web_cpu_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}

resource "aws_appautoscaling_policy" "web_alb_requests" {
  name               = "${local.name}-web-alb-req"
  policy_type        = "TargetTrackingScaling"
  service_namespace  = aws_appautoscaling_target.web.service_namespace
  resource_id        = aws_appautoscaling_target.web.resource_id
  scalable_dimension = aws_appautoscaling_target.web.scalable_dimension

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ALBRequestCountPerTarget"
      # ALB + target-group arn suffixes identify the metric source.
      resource_label = "${aws_lb.web.arn_suffix}/${aws_lb_target_group.web.arn_suffix}"
    }
    target_value       = var.web_alb_requests_target
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
